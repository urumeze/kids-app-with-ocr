// meetingScheduler.js

import { google } from 'googleapis';
import fs from 'fs'; // Import Node.js File System module

// Read the JSON file content synchronously
const rawCredentials = fs.readFileSync('./credentials.json', 'utf-8');
const credentials = JSON.parse(rawCredentials);

const SCOPES = ['www.googleapis.com'];

// Use a Service Account for authentication
const auth = new google.auth.GoogleAuth({
  // keyFile is still the best way to point the library to the file path
  keyFile: './credentials.json', 
  scopes: SCOPES,
});

const calendar = google.calendar({ version: 'v3', auth });

/**
 * Creates a Google Calendar event with a Google Meet link.
 */
async function createMeetEvent(studentEmail, teacherEmail) {
  // ... (rest of the function is the same as before) ...
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour later

  const event = {
    summary: 'GoQuiz Academy Tutoring Session',
    attendees: [
      { email: studentEmail },
      { email: teacherEmail },
    ],
    start: { dateTime: startTime.toISOString() },
    end: { dateTime: endTime.toISOString() },
    conferenceData: {
      createRequest: {
        requestId: `goquiz-session-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };

  const response = await calendar.events.insert({
    calendarId: 'primary', 
    resource: event,
    conferenceDataVersion: 1, 
  });

  return response.data.hangoutLink; 
}

export { createMeetEvent };
