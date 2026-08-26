/**
 * smsService.js
 * High-level SMS service for Arya Fitness Club.
 * Dispatches dynamic Twilio SMS with exact member details:
 * (Name, Joining Date, Expiry Date, Plan Duration, Paid Amount, Payment Method).
 */

const { sendTransactionalSMS } = require("./twoFactorProvider");
const { sendTwilioSMS } = require("./twilioProvider");

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
function getSmsConfig() {
  return {
    provider: (process.env.SMS_PROVIDER || "TWILIO").toUpperCase(),
    apiKey: process.env.TWOFACTOR_API_KEY || "",
    senderId: process.env.TWOFACTOR_SENDER_ID || "ARYFIT",
    paymentTemplate: process.env.TWOFACTOR_PAYMENT_TEMPLATE_NAME || "PAYMENT_SUCCESS",
    expiringTemplate: process.env.TWOFACTOR_EXPIRING_TEMPLATE_NAME || "EXPIRING_SOON",
    expiredTemplate: process.env.TWOFACTOR_EXPIRED_TEMPLATE_NAME || "EXPIRED",
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
    gymName: process.env.GYM_NAME || "Arya Fitness Club",
    mode: process.env.SMS_MODE || "production",
  };
}

// ── DUPLICATE PREVENTION ────────────────────────────────────────────────────
function buildUniqueKey(type, memberId, transactionId = null) {
  if (type === SMS_TYPE.PAYMENT_SUCCESS) {
    return `${memberId}_${transactionId}_PAYMENT_SUCCESS`;
  }
  return `${memberId}_${type}`;
}

async function alreadySent(db, uniqueKey) {
  if (!db) return false;
  const snap = await db
    .collection("smsNotifications")
    .where("uniqueKey", "==", uniqueKey)
    .where("status", "==", SMS_STATUS.SENT)
    .limit(1)
    .get();
  return !snap.empty;
}

// ── LOG TO FIRESTORE ────────────────────────────────────────────────────────
async function logNotification(db, record) {
  if (!db) return;
  const docRef = db.collection("smsNotifications").doc(record.notificationId);
  await docRef.set(record);
}

// ── UNIFIED SMS DISPATCHER ──────────────────────────────────────────────────
async function dispatchSMS({ phone, textMessage, templateName, variables, config }) {
  if (config.provider === "TWILIO") {
    const result = await sendTwilioSMS({
      phone,
      message: textMessage,
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken,
      fromNumber: config.twilioPhoneNumber,
      mode: config.mode,
    });
    return result;
  } else {
    // 2Factor Fallback
    const result = await sendTransactionalSMS({
      phone,
      templateName,
      variables,
      apiKey: config.apiKey,
      senderId: config.senderId,
      mode: config.mode,
    });
    return result;
  }
}

// ── SMS TYPE 1: ACTIVE / PAYMENT SUCCESS / JOINING & RENEWAL ────────────────
async function sendPaymentSuccessSMS(member, transaction, db) {
  const config = getSmsConfig();
  const uniqueKey = buildUniqueKey(SMS_TYPE.PAYMENT_SUCCESS, member.id, transaction.id);
  const notificationId = `sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  const duplicate = await alreadySent(db, uniqueKey);
  if (duplicate) {
    console.log(`[SMS] PAYMENT_SUCCESS already sent for key: ${uniqueKey}. Skipping.`);
    return { success: false, notificationId: null, skipped: true };
  }

  const planText = buildPlanText(member.planMonths);
  const amount = String(Math.round(parseFloat(transaction?.amount) || parseFloat(member.amount) || 0));
  const method = transaction?.method || member.method || "UPI / Online";
  const joiningDate = member.joiningDate || "Today";
  const expiryDate = member.expiryDate || "N/A";
  const gymName = config.gymName || "Arya Fitness Club";

  // Exact Dynamic Template for Active Member
  const messageText = [
    `Hello ${member.name}! 👋`,
    ``,
    `Welcome to *${gymName}*! 💪`,
    `Your membership details:`,
    ``,
    `📅 Joining Date: ${joiningDate}`,
    `⏳ Expiry Date: ${expiryDate}`,
    `⏳ Duration: ${planText}`,
    `💳 Paid: ₹${amount} (${method})`
  ].join("\n");

  const variables = {
    VAR1: member.name,
    VAR2: gymName,
    VAR3: joiningDate,
    VAR4: planText,
    VAR5: expiryDate,
    VAR6: amount,
    VAR7: method,
  };

  const pendingRecord = {
    notificationId,
    uniqueKey,
    memberId: member.id,
    memberName: member.name,
    subscriptionId: String(member.id),
    transactionId: String(transaction.id),
    notificationType: SMS_TYPE.PAYMENT_SUCCESS,
    phoneNumber: member.phone,
    message: messageText,
    status: SMS_STATUS.PENDING,
    provider: config.provider,
    providerMessageId: null,
    sentAt: null,
    errorMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await logNotification(db, pendingRecord);

  const result = await dispatchSMS({
    phone: member.phone,
    textMessage: messageText,
    templateName: config.paymentTemplate,
    variables,
    config,
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

  console.log(`[SMS] ACTIVE (Payment Success) → ${member.name} (${member.phone}) via ${config.provider} → ${finalRecord.status}${result.error ? ' (' + result.error + ')' : ''}`);
  return { success: result.success, error: result.error, notificationId };
}

// ── SMS TYPE 2: EXPIRING SOON ───────────────────────────────────────────────
async function sendExpiringSoonSMS(member, db) {
  const config = getSmsConfig();
  const uniqueKey = buildUniqueKey(SMS_TYPE.EXPIRING_SOON, member.id);
  const notificationId = `sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  const duplicate = await alreadySent(db, uniqueKey);
  if (duplicate) {
    console.log(`[SMS] EXPIRING_SOON already sent for member: ${member.id}. Skipping.`);
    return { success: false, notificationId: null, skipped: true, error: 'Already sent today' };
  }

  const gymName = config.gymName || "Arya Fitness Club";

  // Exact Dynamic Template for Expiring Soon Member
  const messageText = [
    `⚡ GYM MEMBERSHIP EXPIRING SOON - ${gymName} ⚡`,
    ``,
    `Hi ${member.name}! 👋`,
    ``,
    `Your gym membership is expiring soon on ${member.expiryDate}.`,
    `Please renew soon to maintain your daily workout streak! 💪🔥`
  ].join("\n");

  const variables = {
    VAR1: member.name,
    VAR2: member.expiryDate,
    VAR3: gymName,
  };

  const pendingRecord = {
    notificationId,
    uniqueKey,
    memberId: member.id,
    memberName: member.name,
    subscriptionId: String(member.id),
    transactionId: null,
    notificationType: SMS_TYPE.EXPIRING_SOON,
    phoneNumber: member.phone,
    message: messageText,
    status: SMS_STATUS.PENDING,
    provider: config.provider,
    providerMessageId: null,
    sentAt: null,
    errorMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await logNotification(db, pendingRecord);

  const result = await dispatchSMS({
    phone: member.phone,
    textMessage: messageText,
    templateName: config.expiringTemplate,
    variables,
    config,
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

  console.log(`[SMS] EXPIRING_SOON → ${member.name} (${member.phone}) via ${config.provider} → ${finalRecord.status}${result.error ? ' (' + result.error + ')' : ''}`);
  return { success: result.success, error: result.error, notificationId };
}

// ── SMS TYPE 3: EXPIRED ─────────────────────────────────────────────────────
async function sendExpiredSMS(member, db) {
  const config = getSmsConfig();
  const uniqueKey = buildUniqueKey(SMS_TYPE.EXPIRED, member.id);
  const notificationId = `sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  const duplicate = await alreadySent(db, uniqueKey);
  if (duplicate) {
    console.log(`[SMS] EXPIRED already sent for member: ${member.id}. Skipping.`);
    return { success: false, notificationId: null, skipped: true };
  }

  const gymName = config.gymName || "Arya Fitness Club";

  // Exact Dynamic Template for Expired Member
  const messageText = [
    `⚠️ MEMBERSHIP EXPIRED - ${gymName} ⚠️`,
    ``,
    `Hi ${member.name}! 👋`,
    ``,
    `Your gym membership has expired on ${member.expiryDate}.`,
    ``,
    `Don't break your workout flow! Please renew your membership today. 🏋️‍♂️🔥`
  ].join("\n");

  const variables = {
    VAR1: member.name,
    VAR2: member.expiryDate,
    VAR3: gymName,
  };

  const pendingRecord = {
    notificationId,
    uniqueKey,
    memberId: member.id,
    memberName: member.name,
    subscriptionId: String(member.id),
    transactionId: null,
    notificationType: SMS_TYPE.EXPIRED,
    phoneNumber: member.phone,
    message: messageText,
    status: SMS_STATUS.PENDING,
    provider: config.provider,
    providerMessageId: null,
    sentAt: null,
    errorMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await logNotification(db, pendingRecord);

  const result = await dispatchSMS({
    phone: member.phone,
    textMessage: messageText,
    templateName: config.expiredTemplate,
    variables,
    config,
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

  console.log(`[SMS] EXPIRED → ${member.name} (${member.phone}) via ${config.provider} → ${finalRecord.status}${result.error ? ' (' + result.error + ')' : ''}`);
  return { success: result.success, error: result.error, notificationId };
}

// ── HELPERS ─────────────────────────────────────────────────────────────────
function buildPlanText(planMonths) {
  const m = parseInt(planMonths) || 1;
  if (m === 1)  return "1 Month (30 Days)";
  if (m === 2)  return "2 Months (60 Days)";
  if (m === 3)  return "3 Months (90 Days)";
  if (m === 6)  return "6 Months (180 Days)";
  if (m === 12) return "12 Months (1 Year)";
  return `${m} Month${m > 1 ? "s" : ""}`;
}

module.exports = {
  sendPaymentSuccessSMS,
  sendExpiringSoonSMS,
  sendExpiredSMS,
  SMS_TYPE,
  SMS_STATUS,
  buildPlanText,
};
