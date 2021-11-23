/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Calendar as OfficeCalendar } from "@microsoft/microsoft-graph-types-beta";
import { Credential, Prisma, SelectedCalendar } from "@prisma/client";
import { GetTokenResponse } from "google-auth-library/build/src/auth/oauth2client";
import { Auth, calendar_v3, google } from "googleapis";
import { TFunction } from "next-i18next";

import { Event, EventResult } from "@lib/events/EventManager";
import logger from "@lib/logger";
import { VideoCallData } from "@lib/videoClient";

import CalEventParser from "./CalEventParser";
import EventOrganizerMail from "./emails/EventOrganizerMail";
import EventOrganizerRescheduledMail from "./emails/EventOrganizerRescheduledMail";
import { AppleCalendar } from "./integrations/Apple/AppleCalendarAdapter";
import { CalDavCalendar } from "./integrations/CalDav/CalDavCalendarAdapter";
import prisma from "./prisma";

const log = logger.getChildLogger({ prefix: ["[lib] calendarClient"] });

const googleAuth = (credential: Credential) => {
  const { client_secret, client_id, redirect_uris } = JSON.parse(process.env.GOOGLE_API_CREDENTIALS!).web;
  const myGoogleAuth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const googleCredentials = credential.key as Auth.Credentials;
  myGoogleAuth.setCredentials(googleCredentials);

  // FIXME - type errors IDK Why this is a protected method ¯\_(ツ)_/¯
  const isExpired = () => myGoogleAuth.isTokenExpiring();

  const refreshAccessToken = () =>
    myGoogleAuth
      // FIXME - type errors IDK Why this is a protected method ¯\_(ツ)_/¯
      .refreshToken(googleCredentials.refresh_token)
      .then((res: GetTokenResponse) => {
        const token = res.res?.data;
        googleCredentials.access_token = token.access_token;
        googleCredentials.expiry_date = token.expiry_date;
        return prisma.credential
          .update({
            where: {
              id: credential.id,
            },
            data: {
              key: googleCredentials as Prisma.InputJsonValue,
            },
          })
          .then(() => {
            myGoogleAuth.setCredentials(googleCredentials);
            return myGoogleAuth;
          });
      })
      .catch((err) => {
        console.error("Error refreshing google token", err);
        return myGoogleAuth;
      });

  return {
    getToken: () => (!isExpired() ? Promise.resolve(myGoogleAuth) : refreshAccessToken()),
  };
};

function handleErrorsJson(response: Response) {
  if (!response.ok) {
    response.json().then((e) => console.error("O365 Error", e));
    throw Error(response.statusText);
  }
  return response.json();
}

function handleErrorsRaw(response: Response) {
  if (!response.ok) {
    response.text().then((e) => console.error("O365 Error", e));
    throw Error(response.statusText);
  }
  return response.text();
}

type O365AuthCredentials = {
  expiry_date: number;
  access_token: string;
  refresh_token: string;
};

const o365Auth = (credential: Credential) => {
  const isExpired = (expiryDate: number) => expiryDate < Math.round(+new Date() / 1000);
  const o365AuthCredentials = credential.key as O365AuthCredentials;

  const refreshAccessToken = (refreshToken: string) => {
    return fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // FIXME types - IDK how to type this TBH
      body: new URLSearchParams({
        scope: "User.Read Calendars.Read Calendars.ReadWrite",
        client_id: process.env.MS_GRAPH_CLIENT_ID,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        client_secret: process.env.MS_GRAPH_CLIENT_SECRET,
      }),
    })
      .then(handleErrorsJson)
      .then((responseBody) => {
        o365AuthCredentials.access_token = responseBody.access_token;
        o365AuthCredentials.expiry_date = Math.round(+new Date() / 1000 + responseBody.expires_in);
        return prisma.credential
          .update({
            where: {
              id: credential.id,
            },
            data: {
              key: o365AuthCredentials,
            },
          })
          .then(() => o365AuthCredentials.access_token);
      });
  };

  return {
    getToken: () =>
      !isExpired(o365AuthCredentials.expiry_date)
        ? Promise.resolve(o365AuthCredentials.access_token)
        : refreshAccessToken(o365AuthCredentials.refresh_token),
  };
};

export type Person = { name: string; email: string; timeZone: string };

export interface EntryPoint {
  entryPointType?: string;
  uri?: string;
  label?: string;
  pin?: string;
  accessCode?: string;
  meetingCode?: string;
  passcode?: string;
  password?: string;
}

export interface AdditionInformation {
  conferenceData?: ConferenceData;
  entryPoints?: EntryPoint[];
  hangoutLink?: string;
}

export interface CalendarEvent {
  type: string;
  title: string;
  startTime: string;
  endTime: string;
  description?: string | null;
  team?: {
    name: string;
    members: string[];
  };
  location?: string | null;
  organizer: Person;
  attendees: Person[];
  conferenceData?: ConferenceData;
  language: TFunction;
  additionInformation?: AdditionInformation;
  /** If this property exist it we can assume it's a reschedule/update */
  uid?: string | null;
  videoCallData?: VideoCallData;
}

export interface ConferenceData {
  createRequest: calendar_v3.Schema$CreateConferenceRequest;
}
export interface IntegrationCalendar extends Partial<SelectedCalendar> {
  primary?: boolean;
  name?: string;
}

type BufferedBusyTime = { start: string; end: string };
export interface CalendarApiAdapter {
  createEvent(event: CalendarEvent): Promise<Event>;

  updateEvent(uid: string, event: CalendarEvent): Promise<any>;

  deleteEvent(uid: string): Promise<unknown>;

  getAvailability(
    dateFrom: string,
    dateTo: string,
    selectedCalendars: IntegrationCalendar[]
  ): Promise<BufferedBusyTime[]>;

  listCalendars(): Promise<IntegrationCalendar[]>;
}

const MicrosoftOffice365Calendar = (credential: Credential): CalendarApiAdapter => {
  const auth = o365Auth(credential);

  const translateEvent = (event: CalendarEvent) => {
    return {
      subject: event.title,
      body: {
        contentType: "HTML",
        content: event.description,
      },
      start: {
        dateTime: event.startTime,
        timeZone: event.organizer.timeZone,
      },
      end: {
        dateTime: event.endTime,
        timeZone: event.organizer.timeZone,
      },
      attendees: event.attendees.map((attendee) => ({
        emailAddress: {
          address: attendee.email,
          name: attendee.name,
        },
        type: "required",
      })),
      location: event.location ? { displayName: event.location } : undefined,
    };
  };

  const integrationType = "office365_calendar";

  function listCalendars(): Promise<IntegrationCalendar[]> {
    return auth.getToken().then((accessToken) =>
      fetch("https://graph.microsoft.com/v1.0/me/calendars", {
        method: "get",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json",
        },
      })
        .then(handleErrorsJson)
        .then((responseBody: { value: OfficeCalendar[] }) => {
          return responseBody.value.map((cal) => {
            const calendar: IntegrationCalendar = {
              externalId: cal.id ?? "No Id",
              integration: integrationType,
              name: cal.name ?? "No calendar name",
              primary: cal.isDefaultCalendar ?? false,
            };
            return calendar;
          });
        })
    );
  }

  return {
    getAvailability: (dateFrom, dateTo, selectedCalendars) => {
      const filter = `?startdatetime=${encodeURIComponent(dateFrom)}&enddatetime=${encodeURIComponent(
        dateTo
      )}`;
      return auth
        .getToken()
        .then((accessToken) => {
          const selectedCalendarIds = selectedCalendars
            .filter((e) => e.integration === integrationType)
            .map((e) => e.externalId)
            .filter(Boolean);
          if (selectedCalendarIds.length === 0 && selectedCalendars.length > 0) {
            // Only calendars of other integrations selected
            return Promise.resolve([]);
          }

          return (
            selectedCalendarIds.length === 0
              ? listCalendars().then((cals) => cals.map((e) => e.externalId).filter(Boolean) || [])
              : Promise.resolve(selectedCalendarIds)
          ).then((ids) => {
            const requests = ids.map((calendarId, id) => ({
              id,
              method: "GET",
              headers: {
                Prefer: 'outlook.timezone="Etc/GMT"',
              },
              url: `/me/calendars/${calendarId}/calendarView${filter}`,
            }));

            type BatchResponse = {
              responses: SubResponse[];
            };
            type SubResponse = {
              body: { value: { start: { dateTime: string }; end: { dateTime: string } }[] };
            };

            return fetch("https://graph.microsoft.com/v1.0/$batch", {
              method: "POST",
              headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ requests }),
            })
              .then(handleErrorsJson)
              .then((responseBody: BatchResponse) =>
                responseBody.responses.reduce(
                  (acc: BufferedBusyTime[], subResponse) =>
                    acc.concat(
                      subResponse.body.value.map((evt) => {
                        return {
                          start: evt.start.dateTime + "Z",
                          end: evt.end.dateTime + "Z",
                        };
                      })
                    ),
                  []
                )
              );
          });
        })
        .catch((err) => {
          console.log(err);
          return Promise.reject([]);
        });
    },
    createEvent: (event: CalendarEvent) =>
      auth.getToken().then((accessToken) =>
        fetch("https://graph.microsoft.com/v1.0/me/calendar/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(translateEvent(event)),
        })
          .then(handleErrorsJson)
          .then((responseBody) => ({
            ...responseBody,
            disableConfirmationEmail: true,
          }))
      ),
    deleteEvent: (uid: string) =>
      auth.getToken().then((accessToken) =>
        fetch("https://graph.microsoft.com/v1.0/me/calendar/events/" + uid, {
          method: "DELETE",
          headers: {
            Authorization: "Bearer " + accessToken,
          },
        }).then(handleErrorsRaw)
      ),
    updateEvent: (uid: string, event: CalendarEvent) =>
      auth.getToken().then((accessToken) =>
        fetch("https://graph.microsoft.com/v1.0/me/calendar/events/" + uid, {
          method: "PATCH",
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(translateEvent(event)),
        }).then(handleErrorsRaw)
      ),
    listCalendars,
  };
};

const GoogleCalendar = (credential: Credential): CalendarApiAdapter => {
  const auth = googleAuth(credential);
  const integrationType = "google_calendar";

  return {
    getAvailability: (dateFrom, dateTo, selectedCalendars) =>
      new Promise((resolve, reject) =>
        auth.getToken().then((myGoogleAuth) => {
          const calendar = google.calendar({
            version: "v3",
            auth: myGoogleAuth,
          });
          const selectedCalendarIds = selectedCalendars
            .filter((e) => e.integration === integrationType)
            .map((e) => e.externalId);
          if (selectedCalendarIds.length === 0 && selectedCalendars.length > 0) {
            // Only calendars of other integrations selected
            resolve([]);
            return;
          }

          (selectedCalendarIds.length === 0
            ? calendar.calendarList
                .list()
                .then((cals) => cals.data.items?.map((cal) => cal.id).filter(Boolean) || [])
            : Promise.resolve(selectedCalendarIds)
          )
            .then((calsIds) => {
              calendar.freebusy.query(
                {
                  requestBody: {
                    timeMin: dateFrom,
                    timeMax: dateTo,
                    items: calsIds.map((id) => ({ id: id })),
                  },
                },
                (err, apires) => {
                  if (err) {
                    reject(err);
                  }
                  // @ts-ignore FIXME
                  resolve(Object.values(apires.data.calendars).flatMap((item) => item["busy"]));
                }
              );
            })
            .catch((err) => {
              console.error("There was an error contacting google calendar service: ", err);
              reject(err);
            });
        })
      ),
    createEvent: (event: CalendarEvent) =>
      new Promise((resolve, reject) =>
        auth.getToken().then((myGoogleAuth) => {
          const payload: calendar_v3.Schema$Event = {
            summary: event.title,
            description: event.description,
            start: {
              dateTime: event.startTime,
              timeZone: event.organizer.timeZone,
            },
            end: {
              dateTime: event.endTime,
              timeZone: event.organizer.timeZone,
            },
            attendees: event.attendees,
            reminders: {
              useDefault: false,
              overrides: [{ method: "email", minutes: 10 }],
            },
          };

          if (event.location) {
            payload["location"] = event.location;
          }

          if (event.conferenceData && event.location === "integrations:google:meet") {
            payload["conferenceData"] = event.conferenceData;
          }

          const calendar = google.calendar({
            version: "v3",
            auth: myGoogleAuth,
          });
          calendar.events.insert(
            {
              auth: myGoogleAuth,
              calendarId: "primary",
              requestBody: payload,
              conferenceDataVersion: 1,
            },
            function (err, event) {
              if (err || !event?.data) {
                console.error("There was an error contacting google calendar service: ", err);
                return reject(err);
              }
              // @ts-ignore FIXME
              return resolve(event.data);
            }
          );
        })
      ),
    updateEvent: (uid: string, event: CalendarEvent) =>
      new Promise((resolve, reject) =>
        auth.getToken().then((myGoogleAuth) => {
          const payload: calendar_v3.Schema$Event = {
            summary: event.title,
            description: event.description,
            start: {
              dateTime: event.startTime,
              timeZone: event.organizer.timeZone,
            },
            end: {
              dateTime: event.endTime,
              timeZone: event.organizer.timeZone,
            },
            attendees: event.attendees,
            reminders: {
              useDefault: false,
              overrides: [{ method: "email", minutes: 10 }],
            },
          };

          if (event.location) {
            payload["location"] = event.location;
          }

          const calendar = google.calendar({
            version: "v3",
            auth: myGoogleAuth,
          });
          calendar.events.update(
            {
              auth: myGoogleAuth,
              calendarId: "primary",
              eventId: uid,
              sendNotifications: true,
              sendUpdates: "all",
              requestBody: payload,
            },
            function (err, event) {
              if (err) {
                console.error("There was an error contacting google calendar service: ", err);
                return reject(err);
              }
              return resolve(event?.data);
            }
          );
        })
      ),
    deleteEvent: (uid: string) =>
      new Promise((resolve, reject) =>
        auth.getToken().then((myGoogleAuth) => {
          const calendar = google.calendar({
            version: "v3",
            auth: myGoogleAuth,
          });
          calendar.events.delete(
            {
              auth: myGoogleAuth,
              calendarId: "primary",
              eventId: uid,
              sendNotifications: true,
              sendUpdates: "all",
            },
            function (err, event) {
              if (err) {
                console.error("There was an error contacting google calendar service: ", err);
                return reject(err);
              }
              return resolve(event?.data);
            }
          );
        })
      ),
    listCalendars: () =>
      new Promise((resolve, reject) =>
        auth.getToken().then((myGoogleAuth) => {
          const calendar = google.calendar({
            version: "v3",
            auth: myGoogleAuth,
          });
          calendar.calendarList
            .list()
            .then((cals) => {
              resolve(
                cals.data.items?.map((cal) => {
                  const calendar: IntegrationCalendar = {
                    externalId: cal.id ?? "No id",
                    integration: integrationType,
                    name: cal.summary ?? "No name",
                    primary: cal.primary ?? false,
                  };
                  return calendar;
                }) || []
              );
            })
            .catch((err) => {
              console.error("There was an error contacting google calendar service: ", err);
              reject(err);
            });
        })
      ),
  };
};

function getCalendarAdapterOrNull(credential: Credential): CalendarApiAdapter | null {
  switch (credential.type) {
    case "google_calendar":
      return GoogleCalendar(credential);
    case "office365_calendar":
      return MicrosoftOffice365Calendar(credential);
    case "caldav_calendar":
      // FIXME types wrong & type casting should not be needed
      return new CalDavCalendar(credential) as never as CalendarApiAdapter;
    case "apple_calendar":
      // FIXME types wrong & type casting should not be needed
      return new AppleCalendar(credential) as never as CalendarApiAdapter;
  }
  return null;
}

/**
 * @deprecated
 */
const calendars = (withCredentials: Credential[]): CalendarApiAdapter[] =>
  withCredentials
    .map((cred) => {
      switch (cred.type) {
        case "google_calendar":
          return GoogleCalendar(cred);
        case "office365_calendar":
          return MicrosoftOffice365Calendar(cred);
        case "caldav_calendar":
          return new CalDavCalendar(cred);
        case "apple_calendar":
          return new AppleCalendar(cred);
        default:
          return; // unknown credential, could be legacy? In any case, ignore
      }
    })
    .flatMap((item) => (item ? [item as CalendarApiAdapter] : []));

const getBusyCalendarTimes = (
  withCredentials: Credential[],
  dateFrom: string,
  dateTo: string,
  selectedCalendars: SelectedCalendar[]
) =>
  Promise.all(
    calendars(withCredentials).map((c) => c.getAvailability(dateFrom, dateTo, selectedCalendars))
  ).then((results) => {
    return results.reduce((acc, availability) => acc.concat(availability), []);
  });

/**
 *
 * @param withCredentials
 * @deprecated
 */
const listCalendars = (withCredentials: Credential[]) =>
  Promise.all(calendars(withCredentials).map((c) => c.listCalendars())).then((results) =>
    results.reduce((acc, calendars) => acc.concat(calendars), []).filter((c) => c != null)
  );

const createEvent = async (
  credential: Credential,
  calEvent: CalendarEvent,
  noMail: boolean | null = false
): Promise<EventResult> => {
  const parser: CalEventParser = new CalEventParser(calEvent);
  const uid: string = parser.getUid();
  /*
   * Matching the credential type is a workaround because the office calendar simply strips away newlines (\n and \r).
   * We need HTML there. Google Calendar understands newlines and Apple Calendar cannot show HTML, so no HTML should
   * be used for Google and Apple Calendar.
   */
  const richEvent: CalendarEvent = parser.asRichEventPlain();

  let success = true;

  const creationResult = credential
    ? await calendars([credential])[0]
        .createEvent(richEvent)
        .catch((e) => {
          log.error("createEvent failed", e, calEvent);
          success = false;
          return undefined;
        })
    : undefined;

  if (!creationResult) {
    return {
      type: credential.type,
      success,
      uid,
      originalEvent: calEvent,
    };
  }

  const metadata: AdditionInformation = {};
  if (creationResult) {
    // TODO: Handle created event metadata more elegantly
    metadata.hangoutLink = creationResult.hangoutLink;
    metadata.conferenceData = creationResult.conferenceData;
    metadata.entryPoints = creationResult.entryPoints;
  }

  calEvent.additionInformation = metadata;

  if (!noMail) {
    const organizerMail = new EventOrganizerMail(calEvent);

    try {
      await organizerMail.sendEmail();
    } catch (e) {
      console.error("organizerMail.sendEmail failed", e);
    }
  }

  return {
    type: credential.type,
    success,
    uid,
    createdEvent: creationResult,
    originalEvent: calEvent,
  };
};

const updateEvent = async (
  credential: Credential,
  calEvent: CalendarEvent,
  noMail: boolean | null = false,
  bookingRefUid: string | null
): Promise<EventResult> => {
  const parser: CalEventParser = new CalEventParser(calEvent);
  const uid = parser.getUid();
  const richEvent: CalendarEvent = parser.asRichEventPlain();

  let success = true;

  const updatedResult =
    credential && bookingRefUid
      ? await calendars([credential])[0]
          .updateEvent(bookingRefUid, richEvent)
          .catch((e) => {
            log.error("updateEvent failed", e, calEvent);
            success = false;
            return undefined;
          })
      : null;

  if (!updatedResult) {
    return {
      type: credential.type,
      success,
      uid,
      originalEvent: calEvent,
    };
  }

  if (!noMail) {
    const organizerMail = new EventOrganizerRescheduledMail(calEvent);
    try {
      await organizerMail.sendEmail();
    } catch (e) {
      console.error("organizerMail.sendEmail failed", e);
    }
  }

  return {
    type: credential.type,
    success,
    uid,
    updatedEvent: updatedResult,
    originalEvent: calEvent,
  };
};

const deleteEvent = (credential: Credential, uid: string): Promise<unknown> => {
  if (credential) {
    return calendars([credential])[0].deleteEvent(uid);
  }

  return Promise.resolve({});
};

export {
  getBusyCalendarTimes,
  createEvent,
  updateEvent,
  deleteEvent,
  listCalendars,
  getCalendarAdapterOrNull,
};
