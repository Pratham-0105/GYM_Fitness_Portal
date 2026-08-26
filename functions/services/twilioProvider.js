/**
 * twilioProvider.js
 * Twilio SMS Integration for GYM Fitness Portal
 */

const twilio = require("twilio");

function normalisePhone(phone) {
  let cleaned = String(phone).replace(/[^\d+]/g, "");
  if (!cleaned.startsWith("+")) {
    if (cleaned.length === 10) {
      cleaned = "+91" + cleaned;
    } else {
      cleaned = "+" + cleaned;
    }
  }
  return cleaned;
}

async function sendTwilioSMS({
  phone,
  message,
  accountSid = process.env.TWILIO_ACCOUNT_SID,
  authToken = process.env.TWILIO_AUTH_TOKEN,
  fromNumber = process.env.TWILIO_PHONE_NUMBER,
  mode = process.env.SMS_MODE || "production"
}) {
  const formattedTo = normalisePhone(phone);

  if (mode === "mock") {
    const mockSid = "SM_MOCK_" + Date.now();
    console.log(`[Twilio Mock] To: ${formattedTo}, Message: "${message}"`);
    return {
      success: true,
      messageId: mockSid,
      status: "delivered",
      simulated: true
    };
  }

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("Twilio credentials (Account SID, Auth Token, or From Number) are missing in environment variables.");
  }

  try {
    const client = twilio(accountSid, authToken);
    let result;
    try {
      result = await client.messages.create({
        body: message,
        from: fromNumber,
        to: formattedTo
      });
    } catch (err) {
      // If error 572006 (Trial account restricts custom template text to international numbers), fallback to trial template
      if (err.code === 572006 || (err.message && err.message.includes('predefined SMS templates'))) {
        console.warn(`[Twilio Trial Warning] Account is in Trial mode. Dispatching trial pre-approved template to ${formattedTo}...`);
        result = await client.messages.create({
          body: 'sms_appointment_reminders',
          from: fromNumber,
          to: formattedTo
        });
      } else {
        throw err;
      }
    }

    console.log(`[Twilio Live] SMS successfully sent to ${formattedTo}. SID: ${result.sid}`);
    return {
      success: true,
      messageId: result.sid,
      status: result.status || "queued",
      simulated: false
    };
  } catch (error) {
    console.error(`[Twilio Error] Failed sending SMS to ${formattedTo}:`, error.message);
    return {
      success: false,
      error: error.message,
      code: error.code,
      messageId: null
    };
  }
}

module.exports = {
  normalisePhone,
  sendTwilioSMS
};
