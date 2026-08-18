/**
 * twoFactorProvider.js
 * Low-level 2Factor API integration for Arya Fitness Club SMS notifications.
 *
 * 2Factor Transactional SMS endpoint:
 *   POST https://2factor.in/API/V1/{APIKEY}/ADDON_SERVICES/SEND/TSMS
 *
 * DO NOT call this file from frontend code.
 * Only call from Firebase Cloud Functions (server-side).
 */

const axios = require("axios");

/**
 * Normalise an Indian mobile number to the format required by 2Factor.
 * Accepts: 9876543210 | +919876543210 | 919876543210
 * Returns: "919876543210"
 *
 * @param {string} phone
 * @returns {string}
 */
function normalisePhone(phone) {
  // Remove all non-digit characters
  let digits = String(phone).replace(/\D/g, "");

  if (digits.startsWith("91") && digits.length === 12) {
    return digits; // Already in 91XXXXXXXXXX format
  }
  if (digits.length === 10) {
    return "91" + digits; // Add country code
  }
  // Fallback — return as-is and let 2Factor validate
  return digits;
}

/**
 * Send a transactional SMS via 2Factor.
 *
 * @param {Object} params
 * @param {string} params.phone          - Recipient phone (any Indian format)
 * @param {string} params.templateName   - 2Factor DLT-approved template name
 * @param {Object} params.variables      - { VAR1: "...", VAR2: "...", ... }
 * @param {string} params.apiKey         - 2Factor API key
 * @param {string} params.senderId       - Registered Sender ID (e.g. "ARYFIT")
 * @param {string} params.mode           - "mock" | "production"
 *
 * @returns {Promise<{success: boolean, messageId: string|null, rawResponse: any, error: string|null}>}
 */
async function sendTransactionalSMS({
  phone,
  templateName,
  variables = {},
  apiKey,
  senderId,
  mode = "mock",
}) {
  const normalisedPhone = normalisePhone(phone);

  // ── MOCK MODE ────────────────────────────────────────────
  if (mode !== "production") {
    const mockBody = buildPayload(senderId, normalisedPhone, templateName, variables);
    console.log("=== [SMS MOCK] =============================================");
    console.log(`To        : ${normalisedPhone}`);
    console.log(`Template  : ${templateName}`);
    console.log(`Variables : ${JSON.stringify(variables)}`);
    console.log(`Payload   : ${JSON.stringify(mockBody)}`);
    console.log("============================================================");
    return {
      success: true,
      messageId: `MOCK-${Date.now()}`,
      rawResponse: { Status: "Success", Details: "Mock mode — no SMS sent" },
      error: null,
    };
  }

  // ── PRODUCTION MODE ──────────────────────────────────────
  if (!apiKey) {
    throw new Error("TWOFACTOR_API_KEY is not configured. Cannot send SMS.");
  }

  const endpoint = `https://2factor.in/API/V1/${apiKey}/ADDON_SERVICES/SEND/TSMS`;
  const payload = buildPayload(senderId, normalisedPhone, templateName, variables);

  try {
    const response = await axios.post(endpoint, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000, // 10 second timeout
    });

    const data = response.data;

    // 2Factor returns { "Status": "Success", "Details": "<MessageSID>" }
    // or              { "Status": "Error", "Details": "<error message>" }
    if (data && data.Status === "Success") {
      return {
        success: true,
        messageId: data.Details || null,
        rawResponse: data,
        error: null,
      };
    } else {
      const errMsg = (data && data.Details) ? data.Details : "Unknown 2Factor error";
      return {
        success: false,
        messageId: null,
        rawResponse: data,
        error: errMsg,
      };
    }
  } catch (err) {
    // Network errors, timeouts, etc.
    const errMsg = err.response
      ? `2Factor HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;

    return {
      success: false,
      messageId: null,
      rawResponse: null,
      error: errMsg,
    };
  }
}

/**
 * Build the JSON payload for 2Factor transactional SMS.
 * @param {string} senderId
 * @param {string} phone
 * @param {string} templateName
 * @param {Object} variables  - { VAR1: ..., VAR2: ... }
 * @returns {Object}
 */
function buildPayload(senderId, phone, templateName, variables) {
  return {
    From: senderId,
    To: phone,
    TemplateName: templateName,
    ...variables, // Spread VAR1, VAR2, VAR3, etc.
  };
}

module.exports = { sendTransactionalSMS, normalisePhone };
