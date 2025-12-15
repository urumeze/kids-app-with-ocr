// emailService.js

import nodemailer from 'nodemailer'; // <-- Changed from require() to import

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

/**
 * Sends a notification email.
 */
async function sendNotification(to, subject, htmlBody) {
  const mailOptions = {
    from: `"GoQuiz Academy" <${GMAIL_USER}>`,
    to: to,
    subject: subject,
    html: htmlBody,
  };

  await transporter.sendMail(mailOptions);
  console.log(`Email sent successfully to ${to}`);
}

export { sendNotification };
