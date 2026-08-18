/**
 * smsService.js
 * High-level SMS service for Arya Fitness Club.
 *
 * Provides three public functions:
 *   sendPaymentSuccessSMS(member, transaction, db)
 *   sendExpiringSoonSMS(member, db)
 *   sendExpiredSMS(member, db)
 *
 * Each function:
 *  1. Checks the smsNotifications collection for duplicate prevention.
 *  2. Calls twoFactorProvider to send the SMS.
 *  3. Logs the result to Firestore (smsNotifications collection).
 *
 * IMPORTANT: This file is server-side only.
 * Never import it into frontend/browser code.
 */

const { sendTransactionalSMS } = require("./twoFactorProvider");

// ── NOTIFICATION TYPES ──────────────────────────────────────────────────────
const SMS_TYPE = {
  PAYMENT_SUCCESS: "PAYMENT_SUCCESS",
  EXPIRING_SOON: "EXPIRING_SOON",
  EXPIRED: "EXPIRED",
};

const SMS_STATUS = {
  SENT: "SENT",
  FAILED: "FAILED",
  PENDING: "PENDING",
};

// ── CONFIG HELPERS ──────────────────────────────────────────────────────────

/**
 * Load SMS config from environment variables.
 * Firebase Functions uses process.env which is populated from .env files
 * or firebase functions:config / Secret Manager.
 */
function getSmsConfig() {
  return {
    apiKey: process.env.TWOFACTOR_API_KEY || "",
    senderId: process.env.TWOFACTOR_SENDER_ID || "ARYFIT",
    paymentTemplate: process.env.TWOFACTOR_PAYMENT_TEMPLATE_NAME || "PAYMENT_SUCCESS",
    expiringTemplate: process.env.TWOFACTOR_EXPIRING_TEMPLATE_NAME || "EXPIRING_SOON",
    expiredTemplate: process.env.TWOFACTOR_EXPIRED_TEMPLATE_NAME || "EXPIRED",
    gymName: process.env.GYM_NAME || "Arya Fitness Club Shirpur",
    mode: process.env.SMS_MODE || "mock",
  };
}

// ── DUPLICATE PREVENTION ────────────────────────────────────────────────────

/**
 * Build a unique key to prevent duplicate SMS.
 * Payment: "{memberId}_{transactionId}_PAYMENT_SUCCESS"
 * Expiring: "{memberId}_EXPIRING_SOON"
 * Expired:  "{memberId}_EXPIRED"
 */
function buildUniqueKey(type, memberId, transactionId = null) {
  if (type === SMS_TYPE.PAYMENT_SUCCESS) {
    return `${memberId}_${transactionId}_PAYMENT_SUCCESS`;
  }
  return `${memberId}_${type}`;
}

/**
 * Check if this SMS has already been sent successfully.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} uniqueKey
 * @returns {Promise<boolean>}
 */
async function alreadySent(db, uniqueKey) {
  const snap = await db
    .collection("smsNotifications")
    .where("uniqueKey", "==", uniqueKey)
    .where("status", "==", SMS_STATUS.SENT)
    .limit(1)
    .get();
  return !snap.empty;
}

// ── LOG TO FIRESTORE ────────────────────────────────────────────────────────

/**
 * Save SMS notification record to Firestore.
 * @param {FirebaseFirestore.Firestore} db
 * @param {Object} record
 */
async function logNotification(db, record) {
  const docRef = db.collection("smsNotifications").doc(record.notificationId);
  await docRef.set(record);
}

// ── SMS TYPE 1: PAYMENT SUCCESS ─────────────────────────────────────────────

/**
 * Send "Payment Successful" SMS after a new member pass is created.
 *
 * @param {Object} member      - Firestore member record
 * @param {Object} transaction - Firestore transaction record
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<{success: boolean, notificationId: string}>}
 */
async function sendPaymentSuccessSMS(member, transaction, db) {
  const config = getSmsConfig();
  const uniqueKey = buildUniqueKey(SMS_TYPE.PAYMENT_SUCCESS, member.id, transaction.id);
  const notificationId = `sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  // Duplicate prevention
  const duplicate = await alreadySent(db, uniqueKey);
  if (duplicate) {
    console.log(`[SMS] PAYMENT_SUCCESS already sent for key: ${uniqueKey}. Skipping.`);
    return { success: false, notificationId: null, skipped: true };
  }

  // Build plan text from planMonths
  const planText = buildPlanText(member.planMonths);

  // Build template variables for 2Factor
  // Template: Hi {VAR1}, membership created at {VAR2}. Joining: {VAR3}. Plan: {VAR4}. Valid Until: {VAR5}. Amount: Rs.{VAR6}. Payment: {VAR7}.
  const variables = {
    VAR1: member.name,
    VAR2: config.gymName,
    VAR3: member.joiningDate,
    VAR4: planText,
    VAR5: member.expiryDate,
    VAR6: String(Math.round(parseFloat(transaction.amount) || parseFloat(member.amount) || 0)),
    VAR7: transaction.method || member.method || "UPI / Online",
  };

  const messagePreview = buildPaymentMessagePreview(variables, config.gymName);

  // Log PENDING first
  const pendingRecord = {
    notificationId,
    uniqueKey,
    memberId: member.id,
    memberName: member.name,
    subscriptionId: String(member.id),
    transactionId: String(transaction.id),
    notificationType: SMS_TYPE.PAYMENT_SUCCESS,
    phoneNumber: member.phone,
    message: messagePreview,
    status: SMS_STATUS.PENDING,
    provider: "2FACTOR",
    providerMessageId: null,
    sentAt: null,
    errorMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await logNotification(db, pendingRecord);

  // Send SMS
  const result = await sendTransactionalSMS({
    phone: member.phone,
    templateName: config.paymentTemplate,
    variables,
    apiKey: config.apiKey,
    senderId: config.senderId,
    mode: config.mode,
  });

  // Update record with result
  const finalRecord = {
    ...pendingRecord,
    status: result.success ? SMS_STATUS.SENT : SMS_STATUS.FAILED,
    providerMessageId: result.messageId,
    sentAt: result.success ? Date.now() : null,
    errorMessage: result.error || null,
    updatedAt: Date.now(),
  };
  await logNotification(db, finalRecord);

  console.log(`[SMS] PAYMENT_SUCCESS → ${member.name} (${member.phone}) → ${finalRecord.status}`);
  return { success: result.success, notificationId };
}

// ── SMS TYPE 2: EXPIRING SOON ───────────────────────────────────────────────

/**
 * Send "Expiring Soon" SMS — exactly 2 days before expiry.
 *
 * @param {Object} member  - Firestore member record
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<{success: boolean, notificationId: string|null}>}
 */
async function sendExpiringSoonSMS(member, db) {
  const config = getSmsConfig();
  const uniqueKey = buildUniqueKey(SMS_TYPE.EXPIRING_SOON, member.id);
  const notificationId = `sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  const duplicate = await alreadySent(db, uniqueKey);
  if (duplicate) {
    console.log(`[SMS] EXPIRING_SOON already sent for member: ${member.id}. Skipping.`);
    return { success: false, notificationId: null, skipped: true };
  }

  const variables = {
    VAR1: member.name,
    VAR2: member.expiryDate,
    VAR3: config.gymName,
  };

  const messagePreview = `Hi ${member.name}, your membership at ${config.gymName} expires on ${member.expiryDate}. Only 2 days remaining. Please renew to continue gym access.`;

  const pendingRecord = {
    notificationId,
    uniqueKey,
    memberId: member.id,
    memberName: member.name,
    subscriptionId: String(member.id),
    transactionId: null,
    notificationType: SMS_TYPE.EXPIRING_SOON,
    phoneNumber: member.phone,
    message: messagePreview,
    status: SMS_STATUS.PENDING,
    provider: "2FACTOR",
    providerMessageId: null,
    sentAt: null,
    errorMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await logNotification(db, pendingRecord);

  const result = await sendTransactionalSMS({
    phone: member.phone,
    templateName: config.expiringTemplate,
    variables,
    apiKey: config.apiKey,
    senderId: config.senderId,
    mode: config.mode,
  });

  const finalRecord = {
    ...pendingRecord,
    status: result.success ? SMS_STATUS.SENT : SMS_STATUS.FAILED,
    providerMessageId: result.messageId,
    sentAt: result.success ? Date.now() : null,
    errorMessage: result.error || null,
    updatedAt: Date.now(),
  };
  await logNotification(db, finalRecord);

  console.log(`[SMS] EXPIRING_SOON → ${member.name} (${member.phone}) → ${finalRecord.status}`);
  return { success: result.success, notificationId };
}

// ── SMS TYPE 3: EXPIRED ─────────────────────────────────────────────────────

/**
 * Send "Expired" SMS — once when subscription has expired.
 *
 * @param {Object} member  - Firestore member record
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<{success: boolean, notificationId: string|null}>}
 */
async function sendExpiredSMS(member, db) {
  const config = getSmsConfig();
  const uniqueKey = buildUniqueKey(SMS_TYPE.EXPIRED, member.id);
  const notificationId = `sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  const duplicate = await alreadySent(db, uniqueKey);
  if (duplicate) {
    console.log(`[SMS] EXPIRED already sent for member: ${member.id}. Skipping.`);
    return { success: false, notificationId: null, skipped: true };
  }

  const variables = {
    VAR1: member.name,
    VAR2: member.expiryDate,
    VAR3: config.gymName,
  };

  const messagePreview = `Hi ${member.name}, your membership at ${config.gymName} expired on ${member.expiryDate}. Please renew to continue using the gym.`;

  const pendingRecord = {
    notificationId,
    uniqueKey,
    memberId: member.id,
    memberName: member.name,
    subscriptionId: String(member.id),
    transactionId: null,
    notificationType: SMS_TYPE.EXPIRED,
    phoneNumber: member.phone,
    message: messagePreview,
    status: SMS_STATUS.PENDING,
    provider: "2FACTOR",
    providerMessageId: null,
    sentAt: null,
    errorMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await logNotification(db, pendingRecord);

  const result = await sendTransactionalSMS({
    phone: member.phone,
    templateName: config.expiredTemplate,
    variables,
    apiKey: config.apiKey,
    senderId: config.senderId,
    mode: config.mode,
  });

  const finalRecord = {
    ...pendingRecord,
    status: result.success ? SMS_STATUS.SENT : SMS_STATUS.FAILED,
    providerMessageId: result.messageId,
    sentAt: result.success ? Date.now() : null,
    errorMessage: result.error || null,
    updatedAt: Date.now(),
  };
  await logNotification(db, finalRecord);

  console.log(`[SMS] EXPIRED → ${member.name} (${member.phone}) → ${finalRecord.status}`);
  return { success: result.success, notificationId };
}

// ── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Build human-readable plan text from planMonths number.
 * Mirrors the getMemberPlanText() function in the frontend.
 */
function buildPlanText(planMonths) {
  const m = parseInt(planMonths) || 1;
  if (m === 1)  return "1 Month (30 Days)";
  if (m === 2)  return "2 Months (60 Days)";
  if (m === 3)  return "3 Months (90 Days)";
  if (m === 6)  return "6 Months (180 Days)";
  if (m === 12) return "12 Months (365 Days)";
  return `${m} Month${m > 1 ? "s" : ""}`;
}

/**
 * Build a human-readable preview of the Payment Success SMS.
 * This is stored in Firestore for the admin history view.
 */
function buildPaymentMessagePreview(variables, gymName) {
  return [
    `Hi ${variables.VAR1},`,
    ``,
    `Your gym membership at ${variables.VAR2} has been successfully created.`,
    ``,
    `Name: ${variables.VAR1}`,
    `Joining Date: ${variables.VAR3}`,
    `Subscription: ${variables.VAR4}`,
    `Valid Until: ${variables.VAR5}`,
    `Amount Paid: Rs. ${variables.VAR6}`,
    `Payment Method: ${variables.VAR7}`,
    ``,
    `Payment Successful. Thank you!`,
  ].join("\n");
}

module.exports = {
  sendPaymentSuccessSMS,
  sendExpiringSoonSMS,
  sendExpiredSMS,
  SMS_TYPE,
  SMS_STATUS,
  buildPlanText,
};
