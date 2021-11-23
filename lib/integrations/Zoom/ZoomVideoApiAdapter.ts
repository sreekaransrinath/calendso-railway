import { Credential } from "@prisma/client";

import { CalendarEvent } from "@lib/calendarClient";
import { handleErrorsJson, handleErrorsRaw } from "@lib/errors";
import prisma from "@lib/prisma";
import { VideoApiAdapter } from "@lib/videoClient";

/** @link https://marketplace.zoom.us/docs/api-reference/zoom-api/meetings/meetingcreate */
export interface ZoomEventResult {
  created_at: string;
  duration: number;
  host_id: string;
  id: number;
  join_url: string;
  settings: {
    alternative_hosts: string;
    approval_type: number;
    audio: string;
    auto_recording: string;
    close_registration: boolean;
    cn_meeting: boolean;
    enforce_login: boolean;
    enforce_login_domains: string;
    global_dial_in_countries: string[];
    global_dial_in_numbers: {
      city: string;
      country: string;
      country_name: string;
      number: string;
      type: string;
    }[];
    breakout_room: {
      enable: boolean;
      rooms: {
        name: string;
        participants: string[];
      }[];
      host_video: boolean;
      in_meeting: boolean;
      join_before_host: boolean;
      mute_upon_entry: boolean;
      participant_video: boolean;
      registrants_confirmation_email: boolean;
      use_pmi: boolean;
      waiting_room: boolean;
      watermark: boolean;
      registrants_email_notification: boolean;
    };
    start_time: string;
    start_url: string;
    status: string;
    timezone: string;
    topic: string;
    type: number;
    uuid: string;
  };
}

interface ZoomToken {
  scope: "meeting:write";
  expires_in: number;
  token_type: "bearer";
  access_token: string;
  refresh_token: string;
}

const zoomAuth = (credential: Credential) => {
  const credentialKey = credential.key as unknown as ZoomToken;
  const isExpired = (expiryDate: number) => expiryDate < +new Date();
  const authHeader =
    "Basic " +
    Buffer.from(process.env.ZOOM_CLIENT_ID + ":" + process.env.ZOOM_CLIENT_SECRET).toString("base64");

  const refreshAccessToken = (refreshToken: string) =>
    fetch("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    })
      .then(handleErrorsJson)
      .then(async (responseBody) => {
        // Store new tokens in database.
        await prisma.credential.update({
          where: {
            id: credential.id,
          },
          data: {
            key: responseBody,
          },
        });
        credentialKey.access_token = responseBody.access_token;
        credentialKey.expires_in = Math.round(+new Date() / 1000 + responseBody.expires_in);
        return credentialKey.access_token;
      });

  return {
    getToken: () =>
      !isExpired(credentialKey.expires_in)
        ? Promise.resolve(credentialKey.access_token)
        : refreshAccessToken(credentialKey.refresh_token),
  };
};

const ZoomVideoApiAdapter = (credential: Credential): VideoApiAdapter => {
  const auth = zoomAuth(credential);

  const translateEvent = (event: CalendarEvent) => {
    // Documentation at: https://marketplace.zoom.us/docs/api-reference/zoom-api/meetings/meetingcreate
    return {
      topic: event.title,
      type: 2, // Means that this is a scheduled meeting
      start_time: event.startTime,
      duration: (new Date(event.endTime).getTime() - new Date(event.startTime).getTime()) / 60000,
      //schedule_for: "string",   TODO: Used when scheduling the meeting for someone else (needed?)
      timezone: event.attendees[0].timeZone,
      //password: "string",       TODO: Should we use a password? Maybe generate a random one?
      agenda: event.description,
      settings: {
        host_video: true,
        participant_video: true,
        cn_meeting: false, // TODO: true if host meeting in China
        in_meeting: false, // TODO: true if host meeting in India
        join_before_host: true,
        mute_upon_entry: false,
        watermark: false,
        use_pmi: false,
        approval_type: 2,
        audio: "both",
        auto_recording: "none",
        enforce_login: false,
        registrants_email_notification: true,
      },
    };
  };

  return {
    getAvailability: () => {
      return auth
        .getToken()
        .then(
          // TODO Possibly implement pagination for cases when there are more than 300 meetings already scheduled.
          (accessToken) =>
            fetch("https://api.zoom.us/v2/users/me/meetings?type=scheduled&page_size=300", {
              method: "get",
              headers: {
                Authorization: "Bearer " + accessToken,
              },
            })
              .then(handleErrorsJson)
              .then((responseBody) => {
                return responseBody.meetings.map((meeting: { start_time: string; duration: number }) => ({
                  start: meeting.start_time,
                  end: new Date(
                    new Date(meeting.start_time).getTime() + meeting.duration * 60000
                  ).toISOString(),
                }));
              })
        )
        .catch((err) => {
          console.error(err);
          /* Prevents booking failure when Zoom Token is expired */
          return [];
        });
    },
    createMeeting: (event: CalendarEvent) =>
      auth.getToken().then((accessToken) =>
        fetch("https://api.zoom.us/v2/users/me/meetings", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(translateEvent(event)),
        }).then(handleErrorsJson)
      ),
    deleteMeeting: (uid: string) =>
      auth.getToken().then((accessToken) =>
        fetch("https://api.zoom.us/v2/meetings/" + uid, {
          method: "DELETE",
          headers: {
            Authorization: "Bearer " + accessToken,
          },
        }).then(handleErrorsRaw)
      ),
    updateMeeting: (uid: string, event: CalendarEvent) =>
      auth.getToken().then((accessToken: string) =>
        fetch("https://api.zoom.us/v2/meetings/" + uid, {
          method: "PATCH",
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(translateEvent(event)),
        }).then(handleErrorsRaw)
      ),
  };
};

export default ZoomVideoApiAdapter;
