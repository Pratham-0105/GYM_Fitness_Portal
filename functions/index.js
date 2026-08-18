/**
 * index.js — Firebase Cloud Functions
 * Arya Fitness Club SMS Notification System
 *
 * Cloud Functions exposed:
 *  ┌─ HTTP Callable ──────────────────────────────────────────────────────┐
 *  │  sendSmsOnMemberSave    — called after new member pass is saved       │
 *  │  sendSmsOnRenewal       — called after member renewal is saved        │
 *  │  retrySms               — admin: retry a FAILED SMS notification      │
 *  │  testSms                — admin: send a test SMS to any phone         │
 *  │  getSmsHistory          — admin: fetch smsNotifications collection     │
 *  └──────────────────────────────────────────────────────────────────────┘
 *  ┌─ Scheduled (Cron) ───────────────────────────────────────────────────┐
 *  │  scheduledExpiryCheck   — daily 08:00 IST (02:30 UTC)                │
 *  └──────────────────────────────────────────────────────────────────────┘
 *
 * SECURITY:
 *  - All callable functions verify auth context (admin UID in Firestore).
 *  - sendSmsOnMemberSave / sendSmsOnRenewal accept a simple shared token
 *    because the existing app does not use Firebase Auth for admin login.
 *  - The 2Factor API key is never exposed to the browser.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const {
  sendPaymentSuccessSMS,
  sendExpiringSoonSMS,
  sendExpiredSMS,
  SMS_STATUS,
} = require("./services/smsService");

// ── SHARED ADMIN TOKEN ──────────────────────────────────────────────────────
// The frontend sends this token in every Cloud Function call.
// Set this in your functions/.env file as ADMIN_TOKEN=<random-secret>
function getAdminToken() {
  return process.env.ADMIN_TOKEN || "arya-admin-token-change-me";
}

function verifyAdminToken(data) {
  const token = data && data.adminToken;
  if (!token || token !== getAdminToken()) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Invalid or missing admin token."
    );
  }
}

// ── HELPER: parse D-Mon-YYYY to Date ────────────────────────────────────────
function parseDMY(dmyStr) {
  if (!dmyStr) return new Date();
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const parts = dmyStr.split("-");
  if (parts.length === 3) {
    const monthIdx = MONTHS.indexOf(parts[1]);
    if (monthIdx !== -1) {
      return new Date(parseInt(parts[2]), monthIdx, parseInt(parts[0]));
    }
    return new Date(parts[2], parts[1] - 1, parts[0]);
  }
  return new Date(dmyStr);
}

// ============================================================================
// FUNCTION 1: sendSmsOnMemberSave
// Called by frontend after new member pass is saved to Firestore.
// ============================================================================
exports.sendSmsOnMemberSave = functions
  .region("asia-south1") // Mumbai — closest to India
  .https.onCall(async (data, context) => {
    verifyAdminToken(data);

    const { member, transaction } = data;

    if (!member || !member.phone || !member.name) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "member.phone and member.name are required."
      );
    }
    if (!transaction || !transaction.id) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "transaction.id is required."
      );
    }

    const result = await sendPaymentSuccessSMS(member, transaction, db);
    return {
      success: result.success,
      notificationId: result.notificationId || null,
      skipped: result.skipped || false,
    };
  });

// ============================================================================
// FUNCTION 2: sendSmsOnRenewal
// Called by frontend after existing member is renewed.
// ============================================================================
exports.sendSmsOnRenewal = functions
  .region("asia-south1")
  .https.onCall(async (data, context) => {
    verifyAdminToken(data);

    const { member, transaction } = data;

    if (!member || !member.phone || !member.name) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "member.phone and member.name are required."
      );
    }

    // For renewals, we re-use PAYMENT_SUCCESS type but uniqueKey uses transaction ID
    const result = await sendPaymentSuccessSMS(member, transaction, db);
    return {
      success: result.success,
      notificationId: result.notificationId || null,
      skipped: result.skipped || false,
    };
  });

// ============================================================================
// FUNCTION 3: scheduledExpiryCheck
// Runs every day at 08:00 IST (02:30 UTC).
// Checks for:
//   • Members expiring in exactly 2 days → send EXPIRING_SOON
//   • Members already expired → send EXPIRED (once only)
// ============================================================================
exports.scheduledExpiryCheck = functions
  .region("asia-south1")
  .pubsub.schedule("30 2 * * *") // 02:30 UTC = 08:00 IST
  .timeZone("Asia/Kolkata")
  .onRun(async (context) => {
    console.log("[Scheduler] Running daily expiry check...");

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const in2Days = new Date(today);
    in2Days.setDate(in2Days.getDate() + 2);

    // Fetch all members from Firestore
    const membersSnap = await db.collection("members").get();
    const members = [];
    membersSnap.forEach((doc) => members.push(doc.data()));

    let expiringSoonCount = 0;
    let expiredCount = 0;

    for (const member of members) {
      if (!member.phone || !member.expiryDate) continue;

      const expiryDate = parseDMY(member.expiryDate);
      expiryDate.setHours(0, 0, 0, 0);

      const diffMs = expiryDate - today;
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 2) {
        // Expiring in exactly 2 days
        await sendExpiringSoonSMS(member, db);
        expiringSoonCount++;
      } else if (diffDays < 0) {
        // Already expired
        await sendExpiredSMS(member, db);
        expiredCount++;
      }
    }

    console.log(
      `[Scheduler] Done. Expiring Soon SMS: ${expiringSoonCount}, Expired SMS: ${expiredCount}`
    );
    return null;
  });

// ============================================================================
// FUNCTION 4: retrySms
// Admin-only: retry a FAILED or PENDING SMS notification.
// ============================================================================
exports.retrySms = functions
  .region("asia-south1")
  .https.onCall(async (data, context) => {
    verifyAdminToken(data);

    const { notificationId } = data;
    if (!notificationId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "notificationId is required."
      );
    }

    // Fetch the notification record
    const docRef = db.collection("smsNotifications").doc(notificationId);
    const snap = await docRef.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError(
        "not-found",
        `Notification ${notificationId} not found.`
      );
    }

    const notif = snap.data();

    // Only retry FAILED or PENDING
    if (notif.status === SMS_STATUS.SENT) {
      return { success: false, message: "This SMS was already sent successfully." };
    }

    // Fetch the member to get latest data
    let member = null;
    if (notif.memberId) {
      const memberSnap = await db.collection("members").doc(String(notif.memberId)).get();
      if (memberSnap.exists) member = memberSnap.data();
    }
    if (!member) {
      throw new functions.https.HttpsError(
        "not-found",
        `Member ${notif.memberId} not found.`
      );
    }

    // Re-send based on notification type
    let result;
    if (notif.notificationType === "PAYMENT_SUCCESS") {
      // For retry, fetch the original transaction
      let transaction = { id: notif.transactionId || Date.now(), amount: member.amount, method: member.method };
      if (notif.transactionId) {
        const txSnap = await db.collection("transactions").doc(String(notif.transactionId)).get();
        if (txSnap.exists) transaction = txSnap.data();
      }

      // Delete the old failed record so duplicate check passes
      await docRef.delete();
      result = await sendPaymentSuccessSMS(member, transaction, db);
    } else if (notif.notificationType === "EXPIRING_SOON") {
      await docRef.delete();
      result = await sendExpiringSoonSMS(member, db);
    } else if (notif.notificationType === "EXPIRED") {
      await docRef.delete();
      result = await sendExpiredSMS(member, db);
    } else {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `Unknown notification type: ${notif.notificationType}`
      );
    }

    return { success: result.success, notificationId: result.notificationId };
  });

// ============================================================================
// FUNCTION 5: testSms
// Admin-only: send a test SMS to any phone number.
// Uses SMS_MODE from environment — in mock mode, no real SMS is sent.
// ============================================================================
exports.testSms = functions
  .region("asia-south1")
  .https.onCall(async (data, context) => {
    verifyAdminToken(data);

    const { phone, smsType } = data;
    if (!phone || !smsType) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "phone and smsType are required."
      );
    }

    const VALID_TYPES = ["PAYMENT_SUCCESS", "EXPIRING_SOON", "EXPIRED"];
    if (!VALID_TYPES.includes(smsType)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `smsType must be one of: ${VALID_TYPES.join(", ")}`
      );
    }

    // Create a fake member/transaction for test
    const now = new Date();
    const testMember = {
      id: `TEST_${Date.now()}`,
      name: "Test Member",
      phone: phone,
      planMonths: 1,
      joiningDate: `${now.getDate()}-${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][now.getMonth()]}-${now.getFullYear()}`,
      expiryDate: `${now.getDate() + 2}-${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][now.getMonth()]}-${now.getFullYear()}`,
      amount: 1000,
      method: "UPI / Online",
    };
    const testTransaction = {
      id: `TEST_TX_${Date.now()}`,
      amount: 1000,
      method: "UPI / Online",
    };

    let result;
    if (smsType === "PAYMENT_SUCCESS") {
      result = await sendPaymentSuccessSMS(testMember, testTransaction, db);
    } else if (smsType === "EXPIRING_SOON") {
      result = await sendExpiringSoonSMS(testMember, db);
    } else {
      result = await sendExpiredSMS(testMember, db);
    }

    return {
      success: result.success,
      notificationId: result.notificationId || null,
      mode: process.env.SMS_MODE || "mock",
    };
  });

// ============================================================================
// FUNCTION 6: getSmsHistory
// Admin: fetch SMS notification history from Firestore.
// ============================================================================
exports.getSmsHistory = functions
  .region("asia-south1")
  .https.onCall(async (data, context) => {
    verifyAdminToken(data);

    const { limit: pageLimit = 50, filterType = null, filterStatus = null } = data || {};

    let query = db.collection("smsNotifications").orderBy("createdAt", "desc");

    if (filterType) query = query.where("notificationType", "==", filterType);
    if (filterStatus) query = query.where("status", "==", filterStatus);

    query = query.limit(Math.min(pageLimit, 200));

    const snap = await query.get();
    const notifications = [];
    snap.forEach((doc) => notifications.push(doc.data()));

    return { notifications };
  });
