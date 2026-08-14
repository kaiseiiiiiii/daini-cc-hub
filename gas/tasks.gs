/**
 * 第二CC Hub — チェックリストの期日を Google Chat で促す
 * ============================================================================
 * sync.gs / notify.gs と同じ Apps Script プロジェクトに置いてください。
 * 認証まわり（getAccessToken_ / fsBase_ / requiredProp_）と
 * fsStr_ / fsBool_ / postToChat_ / fetchMemberIdNameMap_ / APP_URL / TZ を
 * 借りています。単独では動きません。
 *
 * 【扱う対象】
 * 掲示板の投稿（boardPosts）のうち dueDate が入っているもの。
 * dueDate が無い投稿はふつうの連絡事項で、ここでは一切触りません。
 *
 * 【Google カレンダー連携は入れていません】
 * 専用カレンダーに相乗りする方式では、作った側が付けた通知が
 * 見ている人に届きません（自分が持っていないカレンダーの通知は、
 * 各自の設定になるのが Google カレンダーの仕様）。
 * 「期日に全員へ自動で通知」を成立させるには、全員をゲストに入れて
 * 招待メールを許容するか、各自が1度だけ通知設定を入れる必要があります。
 * どちらを取るかが決まっていないため、いまは Chat だけで促しています。
 *
 * 【このファイルに書いてはいけないもの】
 *   - Webhook URL（スクリプトプロパティ CHAT_WEBHOOK_URL に置く）
 *   - 社員の氏名（Firestore の members から取得する）
 * ============================================================================
 */

// リマインドを送る時刻の「台」。朝いちで見て動ける時間に寄せる。
var REMIND_HOUR = 9;

// 期限切れを何日まで催促し続けるか。
// 無期限に鳴らすと、諦められたタスクが毎朝ノイズとして残り続け、
// リマインド自体が読まれなくなる。
var OVERDUE_REMIND_DAYS = 7;

// 1回のリマインドに並べる未完了者の上限。
// これを超えたら「ほか◯名」に丸める（全員未完了のときに長くなりすぎるため）。
var REMIND_NAME_MAX = 8;

// boardPosts を読むときのページ上限。
// 上限に当たったらログに残す。黙って打ち切ると
// 「催促されないタスクがある」の原因が追えなくなる。
var TASK_PAGE_MAX = 5;
var TASK_PAGE_SIZE = 300;


// ══════════════════════════════════════════════════════════════════════
//  エントリポイント
// ══════════════════════════════════════════════════════════════════════

/** 1日1回のトリガーから呼ばれる。期日が近い／過ぎている未完了を Chat で促す */
function remindDueTasks() {
  var startedAt = new Date();
  try {
    var webhook = requiredProp_("CHAT_WEBHOOK_URL");
    var token = getAccessToken_();
    var projectId = requiredProp_("FIREBASE_PROJECT_ID");

    var posts = fetchBoardPosts_(projectId, token).filter(function (p) {
      return !p.deleted && p.dueDate;
    });
    var names = fetchMemberIdNameMap_(projectId, token);
    var activeIds = fetchActiveMemberIds_(projectId, token);

    var buckets = { overdue: [], today: [], tomorrow: [] };
    posts.forEach(function (p) {
      var left = daysLeft_(p.dueDate);
      if (left === null) return;
      var pending = pendingMemberIds_(p, activeIds);
      if (!pending.length) return;                       // 全員終わっているものは促さない
      var row = { post: p, pending: pending, left: left };
      if (left === 0) buckets.today.push(row);
      else if (left === 1) buckets.tomorrow.push(row);
      else if (left < 0 && left >= -OVERDUE_REMIND_DAYS) buckets.overdue.push(row);
    });

    var total = buckets.overdue.length + buckets.today.length + buckets.tomorrow.length;
    if (!total) {
      taskLog_("ok", "remind", new Date() - startedAt,
        "促す対象はありませんでした（チェックリスト " + posts.length + "件を確認）");
      return;
    }

    postToChat_(webhook, buildRemindMessage_(buckets, names));
    taskLog_("ok", "remind", new Date() - startedAt,
      "送信しました（期限切れ " + buckets.overdue.length +
      "・本日 " + buckets.today.length + "・明日 " + buckets.tomorrow.length + "）");

  } catch (e) {
    taskLog_("error", "remind", new Date() - startedAt, (e && e.message) || String(e));
    throw e;
  }
}


// ══════════════════════════════════════════════════════════════════════
//  Firestore から読む
// ══════════════════════════════════════════════════════════════════════

/**
 * 掲示板の投稿を全件読む。
 * 新着だけでは足りない（過去の投稿に後から期日が付くことがある）。
 */
function fetchBoardPosts_(projectId, token) {
  var out = [];
  var pageToken = "";
  var pages = 0;
  do {
    var url = fsBase_(projectId) + "boardPosts?pageSize=" + TASK_PAGE_SIZE +
      (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      throw new Error("boardPosts を読めませんでした: " + res.getContentText());
    }
    var body = JSON.parse(res.getContentText());
    (body.documents || []).forEach(function (d) {
      out.push(mapBoardPost_(d));
    });
    pageToken = body.nextPageToken || "";
    pages++;
  } while (pageToken && pages < TASK_PAGE_MAX);

  if (pageToken) {
    Logger.log("boardPosts が " + (TASK_PAGE_MAX * TASK_PAGE_SIZE) +
      "件を超えています。読み切れていない分の期日は催促されません。" +
      "TASK_PAGE_MAX を上げてください。");
  }
  return out;
}

function mapBoardPost_(d) {
  var f = d.fields || {};
  var parts = String(d.name || "").split("/");
  return {
    id: parts[parts.length - 1],
    title: fsStr_(f.title) || "(無題)",
    dueDate: fsStr_(f.dueDate),                 // 無ければ ""
    deleted: fsBool_(f.deleted),
    checkTargets: fsStrList_(f.checkTargets),   // 空配列は「全員」
    doneBy: fsMapKeys_(f.doneBy)
  };
}

/** 配列フィールドを文字列配列にする。null / 未設定は空配列 */
function fsStrList_(v) {
  if (!v || !v.arrayValue || !v.arrayValue.values) return [];
  return v.arrayValue.values.map(function (x) {
    return (x && x.stringValue) ? x.stringValue : "";
  }).filter(String);
}

/** マップフィールドのキー一覧。doneBy から「完了した人」を取り出すのに使う */
function fsMapKeys_(v) {
  if (!v || !v.mapValue || !v.mapValue.fields) return [];
  return Object.keys(v.mapValue.fields);
}

/** 在籍中のメンバーID一覧。checkTargets が空（＝全員）のときの母数 */
function fetchActiveMemberIds_(projectId, token) {
  var ids = [];
  var pageToken = "";
  do {
    var url = fsBase_(projectId) + "members?pageSize=300" +
      (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      throw new Error("members を読めませんでした: " + res.getContentText());
    }
    var body = JSON.parse(res.getContentText());
    (body.documents || []).forEach(function (d) {
      var f = d.fields || {};
      var id = fsStr_(f.memberId);
      // active が false の人は促さない（退職・異動済み）
      if (id && f.active && f.active.booleanValue === true) ids.push(id);
    });
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return ids;
}

/**
 * まだ終わっていない対象者のID。
 * checkTargets が空なら在籍中の全員が対象。アプリ側の taskTargets と
 * 同じ考え方（「全員」を列挙で保存しないので、ここで母数を当てる）。
 */
function pendingMemberIds_(post, activeIds) {
  var targets = post.checkTargets.length ? post.checkTargets : activeIds;
  var done = {};
  post.doneBy.forEach(function (id) { done[id] = true; });
  return targets.filter(function (id) { return !done[id]; });
}

/** "YYYY-MM-DD" を、その日の 0時の Date にする */
function ymdToDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** 期日までの残り日数。0 は本日、負なら過ぎている */
function daysLeft_(ymd) {
  var due = ymdToDate_(ymd);
  if (!due) return null;
  var today = ymdToDate_(Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"));
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}


// ══════════════════════════════════════════════════════════════════════
//  リマインドの文面
// ══════════════════════════════════════════════════════════════════════

function buildRemindMessage_(buckets, names) {
  var lines = ["*チェックリストの期日*"];

  appendRemindGroup_(lines, "⚠️ 期限切れ", buckets.overdue, names, true);
  appendRemindGroup_(lines, "📅 本日まで", buckets.today, names, false);
  appendRemindGroup_(lines, "🗓 明日まで", buckets.tomorrow, names, false);

  lines.push("");
  lines.push("<" + APP_URL + "|第二CC Hub で完了にする>");
  return lines.join("\n");
}

function appendRemindGroup_(lines, label, rows, names, showDays) {
  if (!rows.length) return;
  // 期限が古いものから並べる
  rows.sort(function (a, b) { return a.left - b.left; });
  lines.push("");
  lines.push(label + "（" + rows.length + "件）");
  rows.forEach(function (r) {
    var who = r.pending.slice(0, REMIND_NAME_MAX).map(function (id) {
      return names[id] || id;
    }).join("・");
    var rest = r.pending.length - REMIND_NAME_MAX;
    if (rest > 0) who += " ほか" + rest + "名";
    var suffix = showDays ? "（" + (-r.left) + "日超過）" : "";
    lines.push("• " + r.post.title + suffix + " — 未完了 " + r.pending.length + "名: " + who);
  });
}


// ══════════════════════════════════════════════════════════════════════
//  ログとセットアップ
// ══════════════════════════════════════════════════════════════════════

function taskLog_(result, kind, durationMs, note) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("_task_log");
    if (!sheet) {
      sheet = ss.insertSheet("_task_log");
      sheet.appendRow(["実行時刻", "結果", "種類", "所要(ms)", "内容"]);
    }
    sheet.appendRow([
      Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss"),
      result, kind, durationMs, note || ""
    ]);
    var extra = sheet.getLastRow() - 501;
    if (extra > 0) sheet.deleteRows(2, extra);
  } catch (e) {
    Logger.log("タスクログの書き込みに失敗: " + e);
  }
}

/** トリガーを作り直す。1度だけ実行すればよい */
function installTaskTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "remindDueTasks") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("remindDueTasks").timeBased().atHour(REMIND_HOUR).everyDays(1).create();
  Logger.log("期日リマインド（毎日 " + REMIND_HOUR + "時台）を設定しました");
}

/** 設定確認。セットアップ直後に実行する */
function checkTaskSetup() {
  var out = [];
  var props = PropertiesService.getScriptProperties();
  out.push((props.getProperty("CHAT_WEBHOOK_URL") ? "OK   " : "未設定") + "  スクリプトプロパティ CHAT_WEBHOOK_URL");
  out.push((props.getProperty("FIREBASE_PROJECT_ID") ? "OK   " : "未設定") + "  スクリプトプロパティ FIREBASE_PROJECT_ID");

  try {
    var token = getAccessToken_();
    var pid = requiredProp_("FIREBASE_PROJECT_ID");
    var posts = fetchBoardPosts_(pid, token);
    var tasks = posts.filter(function (p) { return !p.deleted && p.dueDate; });
    var activeIds = fetchActiveMemberIds_(pid, token);
    var open = tasks.filter(function (p) { return pendingMemberIds_(p, activeIds).length; });
    out.push("OK      掲示板 " + posts.length + "件／チェックリスト " + tasks.length +
      "件（未完了が残っているもの " + open.length + "件）");
  } catch (e) {
    out.push("失敗    Firestore 接続: " + e.message);
  }

  var installed = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  out.push((installed.indexOf("remindDueTasks") >= 0 ? "OK   " : "未設定") + "  トリガー remindDueTasks");

  Logger.log(out.join("\n"));
  return out.join("\n");
}

/**
 * 「催促が来ない」を切り分ける。
 * チェックリストの一覧と、それぞれが催促の対象かどうかを並べて出す。
 */
function whyNoRemind() {
  var token = getAccessToken_();
  var pid = requiredProp_("FIREBASE_PROJECT_ID");
  var posts = fetchBoardPosts_(pid, token);
  var activeIds = fetchActiveMemberIds_(pid, token);
  var names = fetchMemberIdNameMap_(pid, token);
  var tasks = posts.filter(function (p) { return p.dueDate; });
  var out = [];

  out.push("本日: " + Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd") +
    "／催促は毎日 " + REMIND_HOUR + "時台、期限切れは " + OVERDUE_REMIND_DAYS + "日まで");
  out.push("");

  if (!tasks.length) {
    out.push("期日が入っている投稿が1件もありません。");
    out.push("（アプリの掲示板で「期日」を入れて投稿すると、ここに出ます）");
  }

  tasks.forEach(function (p) {
    var left = daysLeft_(p.dueDate);
    var pending = pendingMemberIds_(p, activeIds);
    var mark;
    if (p.deleted) mark = "削除済みのため対象外";
    else if (!pending.length) mark = "全員完了のため対象外";
    else if (left === 0) mark = "★ 本日まで";
    else if (left === 1) mark = "★ 明日まで";
    else if (left < 0 && left >= -OVERDUE_REMIND_DAYS) mark = "★ 期限切れ（" + (-left) + "日超過）";
    else if (left < 0) mark = (-left) + "日超過。" + OVERDUE_REMIND_DAYS + "日を過ぎたため対象外";
    else mark = "まだ " + left + "日あるため対象外";
    var who = pending.map(function (id) { return names[id] || id; }).join("・");
    out.push("  " + p.dueDate + "  " + p.title + "  → " + mark +
      (pending.length ? "（未完了 " + pending.length + "名: " + who + "）" : ""));
  });

  Logger.log(out.join("\n"));
  return out.join("\n");
}
