// MoveApp — outbound notifications.
//
// Every OTP leaves the system through this file. Right now both functions log
// to the console. When you buy an email/SMS provider you change ONLY this
// file — no controller, route, or database change is needed.
//
// Email provider options: Resend (easiest setup), SendGrid, AWS SES (cheapest).
// SMS provider options:   Twilio, Vonage, MessageBird.
//
// Before real email will land in inboxes rather than spam, the sending domain
// needs SPF, DKIM and DMARC DNS records. That needs DNS access, not code —
// worth starting early.

const sendEmailOtp = async (email, otp) => {
    // TODO: replace with the real provider, e.g.
    //
    //   const { Resend } = require("resend");
    //   const resend = new Resend(process.env.RESEND_API_KEY);
    //   await resend.emails.send({
    //       from: process.env.MAIL_FROM,
    //       to: email,
    //       subject: "Your MoveApp verification code",
    //       text: `Your code is ${otp}. It expires in 5 minutes.`
    //   });

    console.log(`[EMAIL OTP] to=${email} code=${otp}`);
    return true;
};

const sendSmsOtp = async (phone, otp) => {
    // TODO: replace with the real provider (Twilio / Vonage / MessageBird).
    console.log(`[SMS OTP] to=${phone} code=${otp}`);
    return true;
};

module.exports = { sendEmailOtp, sendSmsOtp };