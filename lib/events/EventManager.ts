import { Credential } from "@prisma/client";
import async from "async";
import merge from "lodash/merge";
import { v5 as uuidv5 } from "uuid";

import { AdditionInformation, CalendarEvent, createEvent, updateEvent } from "@lib/calendarClient";
import EventAttendeeMail from "@lib/emails/EventAttendeeMail";
import EventAttendeeRescheduledMail from "@lib/emails/EventAttendeeRescheduledMail";
import { DailyEventResult, FAKE_DAILY_CREDENTIAL } from "@lib/integrations/Daily/DailyVideoApiAdapter";
import { ZoomEventResult } from "@lib/integrations/Zoom/ZoomVideoApiAdapter";
import { LocationType } from "@lib/location";
import prisma from "@lib/prisma";
import { Ensure } from "@lib/types/utils";
import { createMeeting, updateMeeting, VideoCallData } from "@lib/videoClient";

export type Event = AdditionInformation & { name: string; id: string; disableConfirmationEmail?: boolean } & (
    | ZoomEventResult
    | DailyEventResult
  );

export interface EventResult {
  type: string;
  success: boolean;
  uid: string;
  createdEvent?: Event;
  updatedEvent?: Event;
  originalEvent: CalendarEvent;
  videoCallData?: VideoCallData;
}

export interface CreateUpdateResult {
  results: Array<EventResult>;
  referencesToCreate: Array<PartialReference>;
}

export interface PartialBooking {
  id: number;
  references: Array<PartialReference>;
}

export interface PartialReference {
  id?: number;
  type: string;
  uid: string;
  meetingId?: string | null;
  meetingPassword?: string | null;
  meetingUrl?: string | null;
}

interface GetLocationRequestFromIntegrationRequest {
  location: string;
}

export default class EventManager {
  calendarCredentials: Array<Credential>;
  videoCredentials: Array<Credential>;

  /**
   * Takes an array of credentials and initializes a new instance of the EventManager.
   *
   * @param credentials
   */
  constructor(credentials: Array<Credential>) {
    this.calendarCredentials = credentials.filter((cred) => cred.type.endsWith("_calendar"));
    this.videoCredentials = credentials.filter((cred) => cred.type.endsWith("_video"));

    //for  Daily.co video, temporarily pushes a credential for the daily-video-client
    const hasDailyIntegration = process.env.DAILY_API_KEY;
    if (hasDailyIntegration) {
      this.videoCredentials.push(FAKE_DAILY_CREDENTIAL);
    }
  }

  /**
   * Takes a CalendarEvent and creates all necessary integration entries for it.
   * When a video integration is chosen as the event's location, a video integration
   * event will be scheduled for it as well.
   *
   * @param event
   */
  public async create(event: Ensure<CalendarEvent, "language">): Promise<CreateUpdateResult> {
    const evt = EventManager.processLocation(event);
    const isDedicated = evt.location ? EventManager.isDedicatedIntegration(evt.location) : null;

    // First, create all calendar events. If this is a dedicated integration event, don't send a mail right here.
    const results: Array<EventResult> = await this.createAllCalendarEvents(evt, isDedicated);
    // If and only if event type is a dedicated meeting, create a dedicated video meeting.
    if (isDedicated) {
      const result = await this.createVideoEvent(evt);
      if (result.videoCallData) {
        evt.videoCallData = result.videoCallData;
      }
      results.push(result);
    } else {
      await EventManager.sendAttendeeMail("new", results, evt);
    }

    const referencesToCreate: Array<PartialReference> = results.map((result: EventResult) => {
      let uid = "";
      if (result.createdEvent) {
        const isDailyResult = result.type === "daily_video";
        if (isDailyResult) {
          uid = (result.createdEvent as DailyEventResult).name.toString();
        } else {
          uid = (result.createdEvent as ZoomEventResult).id.toString();
        }
      }
      return {
        type: result.type,
        uid,
        meetingId: result.videoCallData?.id.toString(),
        meetingPassword: result.videoCallData?.password,
        meetingUrl: result.videoCallData?.url,
      };
    });

    return {
      results,
      referencesToCreate,
    };
  }

  /**
   * Takes a calendarEvent and a rescheduleUid and updates the event that has the
   * given uid using the data delivered in the given CalendarEvent.
   *
   * @param event
   */
  public async update(
    event: Ensure<CalendarEvent, "language">,
    rescheduleUid: string
  ): Promise<CreateUpdateResult> {
    const evt = EventManager.processLocation(event);

    if (!rescheduleUid) {
      throw new Error("You called eventManager.update without an `rescheduleUid`. This should never happen.");
    }

    // Get details of existing booking.
    const booking = await prisma.booking.findFirst({
      where: {
        uid: rescheduleUid,
      },
      select: {
        id: true,
        references: {
          select: {
            id: true,
            type: true,
            uid: true,
            meetingId: true,
            meetingPassword: true,
            meetingUrl: true,
          },
        },
      },
    });

    if (!booking) {
      throw new Error("booking not found");
    }

    const isDedicated = evt.location ? EventManager.isDedicatedIntegration(evt.location) : null;
    // First, create all calendar events. If this is a dedicated integration event, don't send a mail right here.
    const results: Array<EventResult> = await this.updateAllCalendarEvents(evt, booking, isDedicated);
    // If and only if event type is a dedicated meeting, update the dedicated video meeting.
    if (isDedicated) {
      const result = await this.updateVideoEvent(evt, booking);
      if (result.videoCallData) {
        evt.videoCallData = result.videoCallData;
      }
      results.push(result);
    } else {
      await EventManager.sendAttendeeMail("reschedule", results, evt);
    }
    // Now we can delete the old booking and its references.
    const bookingReferenceDeletes = prisma.bookingReference.deleteMany({
      where: {
        bookingId: booking.id,
      },
    });
    const attendeeDeletes = prisma.attendee.deleteMany({
      where: {
        bookingId: booking.id,
      },
    });

    const bookingDeletes = prisma.booking.delete({
      where: {
        id: booking.id,
      },
    });

    // Wait for all deletions to be applied.
    await Promise.all([bookingReferenceDeletes, attendeeDeletes, bookingDeletes]);

    return {
      results,
      referencesToCreate: [...booking.references],
    };
  }

  /**
   * Creates event entries for all calendar integrations given in the credentials.
   * When noMail is true, no mails will be sent. This is used when the event is
   * a video meeting because then the mail containing the video credentials will be
   * more important than the mails created for these bare calendar events.
   *
   * When the optional uid is set, it will be used instead of the auto generated uid.
   *
   * @param event
   * @param noMail
   * @private
   */

  private async createAllCalendarEvents(
    event: CalendarEvent,
    noMail: boolean | null
  ): Promise<Array<EventResult>> {
    const [firstCalendar] = this.calendarCredentials;
    if (!firstCalendar) {
      return [];
    }
    return [await createEvent(firstCalendar, event, noMail)];
  }

  /**
   * Checks which video integration is needed for the event's location and returns
   * credentials for that - if existing.
   * @param event
   * @private
   */

  private getVideoCredential(event: CalendarEvent): Credential | undefined {
    if (!event.location) {
      return undefined;
    }

    const integrationName = event.location.replace("integrations:", "");

    return this.videoCredentials.find((credential: Credential) => credential.type.includes(integrationName));
  }

  /**
   * Creates a video event entry for the selected integration location.
   *
   * When optional uid is set, it will be used instead of the auto generated uid.
   *
   * @param event
   * @private
   */
  private createVideoEvent(event: Ensure<CalendarEvent, "language">): Promise<EventResult> {
    const credential = this.getVideoCredential(event);

    if (credential) {
      return createMeeting(credential, event);
    } else {
      return Promise.reject("No suitable credentials given for the requested integration name.");
    }
  }

  /**
   * Updates the event entries for all calendar integrations given in the credentials.
   * When noMail is true, no mails will be sent. This is used when the event is
   * a video meeting because then the mail containing the video credentials will be
   * more important than the mails created for these bare calendar events.
   *
   * @param event
   * @param booking
   * @param noMail
   * @private
   */
  private updateAllCalendarEvents(
    event: CalendarEvent,
    booking: PartialBooking | null,
    noMail: boolean | null
  ): Promise<Array<EventResult>> {
    return async.mapLimit(this.calendarCredentials, 5, async (credential) => {
      const bookingRefUid = booking
        ? booking.references.filter((ref) => ref.type === credential.type)[0]?.uid
        : null;
      return updateEvent(credential, event, noMail, bookingRefUid);
    });
  }

  /**
   * Updates a single video event.
   *
   * @param event
   * @param booking
   * @private
   */
  private updateVideoEvent(event: CalendarEvent, booking: PartialBooking) {
    const credential = this.getVideoCredential(event);

    if (credential) {
      const bookingRef = booking ? booking.references.filter((ref) => ref.type === credential.type)[0] : null;
      const bookingRefUid = bookingRef ? bookingRef.uid : null;
      return updateMeeting(credential, event, bookingRefUid).then((returnVal: EventResult) => {
        // Some video integrations, such as Zoom, don't return any data about the booking when updating it.
        if (returnVal.videoCallData === undefined) {
          returnVal.videoCallData = EventManager.bookingReferenceToVideoCallData(bookingRef);
        }
        return returnVal;
      });
    } else {
      return Promise.reject("No suitable credentials given for the requested integration name.");
    }
  }

  /**
   * Returns true if the given location describes a dedicated integration that
   * delivers meeting credentials. Zoom, for example, is dedicated, because it
   * needs to be called independently from any calendar APIs to receive meeting
   * credentials. Google Meetings, in contrast, are not dedicated, because they
   * are created while scheduling a regular calendar event by simply adding some
   * attributes to the payload JSON.
   *
   * @param location
   * @private
   */
  private static isDedicatedIntegration(location: string): boolean {
    // Hard-coded for now, because Zoom and Google Meet are both integrations, but one is dedicated, the other one isn't.

    return location === "integrations:zoom" || location === "integrations:daily";
  }

  /**
   * Helper function for processLocation: Returns the conferenceData object to be merged
   * with the CalendarEvent.
   *
   * @param locationObj
   * @private
   */
  private static getLocationRequestFromIntegration(locationObj: GetLocationRequestFromIntegrationRequest) {
    const location = locationObj.location;

    if (
      location === LocationType.GoogleMeet.valueOf() ||
      location === LocationType.Zoom.valueOf() ||
      location === LocationType.Daily.valueOf()
    ) {
      const requestId = uuidv5(location, uuidv5.URL);

      return {
        conferenceData: {
          createRequest: {
            requestId: requestId,
          },
        },
        location,
      };
    }

    return null;
  }

  /**
   * Takes a CalendarEvent and adds a ConferenceData object to the event
   * if the event has an integration-related location.
   *
   * @param event
   * @private
   */
  private static processLocation<T extends CalendarEvent>(event: T): T {
    // If location is set to an integration location
    // Build proper transforms for evt object
    // Extend evt object with those transformations
    if (event.location?.includes("integration")) {
      const maybeLocationRequestObject = EventManager.getLocationRequestFromIntegration({
        location: event.location,
      });

      event = merge(event, maybeLocationRequestObject);
    }

    return event;
  }

  /**
   * Accepts a PartialReference object and, if all data is complete,
   * returns a VideoCallData object containing the meeting information.
   *
   * @param reference
   * @private
   */
  private static bookingReferenceToVideoCallData(
    reference: PartialReference | null
  ): VideoCallData | undefined {
    let isComplete = true;

    if (!reference) {
      throw new Error("missing reference");
    }

    switch (reference.type) {
      case "zoom_video":
        // Zoom meetings in our system should always have an ID, a password and a join URL. In the
        // future, it might happen that we consider making passwords for Zoom meetings optional.
        // Then, this part below (where the password existence is checked) needs to be adapted.
        isComplete =
          reference.meetingId !== undefined &&
          reference.meetingPassword !== undefined &&
          reference.meetingUrl !== undefined;
        break;
      default:
        isComplete = true;
    }

    if (isComplete) {
      return {
        type: reference.type,
        // The null coalescing operator should actually never be used here, because we checked if it's defined beforehand.
        id: reference.meetingId ?? "",
        password: reference.meetingPassword ?? "",
        url: reference.meetingUrl ?? "",
      };
    } else {
      return undefined;
    }
  }

  /**
   * Conditionally sends an email to the attendee.
   *
   * @param type
   * @param results
   * @param event
   * @private
   */
  private static async sendAttendeeMail(
    type: "new" | "reschedule",
    results: Array<EventResult>,
    event: CalendarEvent
  ) {
    if (
      !results.length ||
      !results.some((eRes) => (eRes.createdEvent || eRes.updatedEvent)?.disableConfirmationEmail)
    ) {
      const metadata: AdditionInformation = {};
      if (results.length) {
        // TODO: Handle created event metadata more elegantly
        metadata.hangoutLink = results[0].createdEvent?.hangoutLink;
        metadata.conferenceData = results[0].createdEvent?.conferenceData;
        metadata.entryPoints = results[0].createdEvent?.entryPoints;
      }

      event.additionInformation = metadata;

      let attendeeMail;
      switch (type) {
        case "reschedule":
          attendeeMail = new EventAttendeeRescheduledMail(event);
          break;
        case "new":
          attendeeMail = new EventAttendeeMail(event);
          break;
      }
      try {
        await attendeeMail.sendEmail();
      } catch (e) {
        console.error("attendeeMail.sendEmail failed", e);
      }
    }
  }
}
