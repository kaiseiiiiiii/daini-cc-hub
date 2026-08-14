/**
 * 第二CC Hub — チェックリストの期日を Google カレンダーに出し、期日前後に Chat で促す
 * ============================================================================
 * sync.gs / notify.gs と同じ Apps Script プロジェクトに置いてください。
 * 認証まわり（getAccessToken_ / fsBase_ / requiredProp_ / patchFields_ など）と
 * fsStr_ / fsBool_ / postToChat_ / fetchMemberIdNameMap_ を借りています。
 * 単独では動きません。
 *
 * 【扱う対象】
 * 掲示板の投稿（boardPosts）のうち dueDate が入っているもの。
 * dueDate が無い投稿はふつうの連絡事項で、ここでは一切触りません。
 *
 * 【なぜサービスアカウントでカレンダーに書かないか】
 * サービスアカウントは、ドメイン全体の委任を設定しない限り
 * 人のカレンダーに書けません。委任は「全社員のカレンダーを代理操作できる鍵」を
 * 作ることであり、チェックリストのために持つ権限としては過大です。
 * そのため、このスクリプトの所有者（＝実行者）の権限で
 * 専用カレンダー1つに書く方式にしています。
 *
 * 【このファイルに書いてはいけないもの】
 *   - カレンダーID（スクリプトプロパティ TASK_CALENDAR_ID に置く）
 *   - Webhook URL（CHAT_WEBHOOK_URL に置く）
 *   - 社員の氏名（Firestore の members から取得する）
 * ============================================================================
 */

// リマインドを送る時刻の「台」。朝いちで見て動ける時間に寄せる。
var REMIND_HOUR = 9;

// 期限切れを何日まで催促し続けるか。
// 無期限に鳴らすと、諦められたタスクが毎朝ノイズとして残り続ける。
var OVERDUE_REMIND_DAYS = 7;

// 1回のリマインドに並べる未完了者の上限。
// これを超えたら「ほか◯名」に丸める（全員未完了のときに長くなりすぎるため）。
var REMIND_NAME_MAX = 8;

// boardPosts を読むときのページ上限。
// 上限に当たったらログに残す。黙って打ち切ると
// 「カレンダーに出ないタスクがある」の原因が追えなくなる。
var TASK_PAGE_MAX = 5;
var TASK_PAGE_SIZE = 300;


// ══════════════════════════════════════════════════════════════════════
//  エントリポイント
// ══════════════════════════════════════════════════════════════════════

/** 15分おきのトリガーから呼ばれる。期日をカレンダーに反映する */
function syncTaskCalendar() {
  var startedAt = new Date();
  var counts = { created: 0, updated: 0, deleted: 0, skipped: 0 };
  try {
    var calId = requiredProp_("TASK_CALENDAR_ID");
    var cal = CalendarApp.getCalendarById(calId);
    if (!cal) {
      throw new Error("カレンダーが見つかりません（TASK_CALENDAR_ID を確認してください）: " + calId);
    }
    var token = getAccessToken_();
    var projectId = requiredProp_("FIREBASE_PROJECT_ID");

    fetchBoardPosts_(projectId, token).forEach(function (p) {
      try {
        reconcileEvent_(cal, projectId, token, p, counts);
      } catch (e) {
        // 1件の失敗で残り全部を止めない。
        // カレンダー側の一時的な失敗はよくあり、次の実行で追いつけばよい。
        counts.skipped++;
        Logger.log("予定の同期に失敗（" + p.id + "）: " + ((e && e.message) || e));
      }
    });

    taskLog_("ok", "calendar", new Date() - startedAt,
      "作成 " + counts.created + "・更新 " + counts.updated +
      "・削除 " + counts.deleted + "・失敗 " + counts.skipped);

  } catch (e) {
    taskLog_("error", "calendar", new Date() - startedAt, (e && e.message) || String(e));
    throw e;
  }
}

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
    var targetsSource = fetchActiveMemberIds_(projectId, token);

    var buckets = { overdue: [], today: [], tomorrow: [] };
    posts.forEach(function (p) {
      var left = daysLeft_(p.dueDate);
      if (left === null) return;
      var pending = pendingMemberIds_(p, targetsSource);
      if (!pending.length) return;                       // 全員終わっているものは促さない
      var row = { post: p, pending: pending, left: left };
      if (left === 0) buckets.today.push(row);
      else if (left === 1) buckets.tomorrow.push(row);
      else if (left < 0 && left >= -OVERDUE_REMIND_DAYS) buckets.overdue.push(row);
    });

    var total = buckets.overdue.length + buckets.today.length + buckets.tomorrow.length;
    if (!total) {
      taskLog_("ok", "remind", new Date() - startedAt, "促す対象はありませんでした");
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
 * 「dueDate があるものには予定がある」という状態を保ちたいので、
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
      "件を超えています。読み切れていない分の期日はカレンダーに出ません。" +
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
    dueDate: fsStr_(f.dueDate),                  // 無ければ ""
    deleted: fsBool_(f.deleted),
    checkTargets: fsStrList_(f.checkTargets),     // 空配列は「全員」
    doneBy: fsMapKeys_(f.doneBy),
    calendarEventId: fsStr_(f.calendarEventId)
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


// ══════════════════════════════════════════════════════════════════════
//  カレンダー
// ══════════════════════════════════════════════════════════════════════

/**
 * 1件の投稿について、カレンダーの予定をあるべき姿に合わせる。
 *
 *   期日あり・未削除 → 終日予定が1つある
 *   期日なし／削除済 → 予定は無い
 *
 * 予定IDを Firestore 側に持たせているので、実行ごとに作り直す必要はない。
 * 「作ったかどうか」をカレンダーの検索で判定する方式にすると、
 * 同名の予定を人が手で作ったときに取り違える。
 */
function reconcileEvent_(cal, projectId, token, post, counts) {
  var wanted = !post.deleted && !!post.dueDate;
  var date = wanted ? ymdToDate_(post.dueDate) : null;
  if (wanted && !date) {
    // ルール側で形を縛っているので通常は起きない。壊れた値を
    // カレンダーに書かず、記録だけ残して次へ進む。
    counts.skipped++;
    Logger.log("期日の形が不正です（" + post.id + "）: " + post.dueDate);
    return;
  }

  var ev = post.calendarEventId ? cal.getEventById(post.calendarEventId) : null;

  // 予定が要らないのに残っている → 消す
  if (!wanted) {
    if (ev) { ev.deleteEvent(); counts.deleted++; }
    if (post.calendarEventId) {
      patchFieldsChecked_(projectId, token, "boardPosts/" + post.id, { calendarEventId: null });
    }
    return;
  }

  var title = "【第二CC】" + post.title;
  var desc = "第二CC Hub のチェックリストです。完了のチェックはアプリで行ってください。\n" + APP_URL;

  // ID を持っていても予定が無い＝人がカレンダーから消した。作り直す。
  if (!ev) {
    var made = cal.createAllDayEvent(title, date);
    made.setDescription(desc);
    patchFieldsChecked_(projectId, token, "boardPosts/" + post.id, { calendarEventId: made.getId() });
    counts.created++;
    return;
  }

  // 既にある。題名と日付がずれていたときだけ直す。
  // 毎回 set すると、更新していないのに更新通知が飛ぶ。
  var changed = false;
  if (ev.getTitle() !== title) { ev.setTitle(title); changed = true; }
  if (!sameDay_(ev.getAllDayStartDate(), date)) { ev.setAllDayDate(date); changed = true; }
  if (changed) counts.updated++;
}

/** "YYYY-MM-DD" を、その日の 0時の Date にする */
function ymdToDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function sameDay_(a, b) {
  if (!a || !b) return false;
  return Utilities.formatDate(a, TZ, "yyyy-MM-dd") === Utilities.formatDate(b, TZ, "yyyy-MM-dd");
}

/** 期日までの残り日数。0 は本日、負なら過ぎている */
function daysLeft_(ymd) {
  var due = ymdToDate_(ymd);
  if (!due) return null;
  var today = ymdToDate_(Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"));
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

/**
 * 一部のフィールドだけ更新する。sync.gs の patchFields_ と同じことをするが、
 * 失敗したら必ず例外にする。
 * 予定IDの書き戻しが黙って失敗すると、次の実行でまた予定を作り、
 * カレンダーに同じ予定が積み上がっていく。
 */
function patchFieldsChecked_(projectId, token, path, obj) {
  var keys = Object.keys(obj);
  var mask = keys.map(function (k) {
    return "updateMask.fieldPaths=" + encodeURIComponent(k);
  }).join("&");
  var res = UrlFetchApp.fetch(fsBase_(projectId) + path + "?" + mask, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ fields: toFsFields_(obj) }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error(path + " の " + keys.join(",") + " を書けませんでした: " + res.getContentText());
  }
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
    var fn = t.getHandlerFunction();
    if (fn === "syncTaskCalendar" || fn === "remindDueTasks") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncTaskCalendar").timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger("remindDueTasks").timeBased().atHour(REMIND_HOUR).everyDays(1).create();
  Logger.log("カレンダー同期（15分おき）と期日リマインド（毎日 " + REMIND_HOUR + "時台）を設定しました");
}

/** 設定確認。セットアップ直後に実行する */
function checkTaskSetup() {
  var out = [];
  var props = PropertiesService.getScriptProperties();
  var calId = props.getProperty("TASK_CALENDAR_ID");
  out.push((calId ? "OK   " : "未設定") + "  スクリプトプロパティ TASK_CALENDAR_ID");
  out.push((props.getProperty("CHAT_WEBHOOK_URL") ? "OK   " : "未設定") + "  スクリプトプロパティ CHAT_WEBHOOK_URL");

  if (calId) {
    var cal = CalendarApp.getCalendarById(calId);
    out.push(cal
      ? "OK      カレンダー「" + cal.getName() + "」に書けます"
      : "失敗    カレンダーが見つかりません（IDが違う、または共有されていません）");
  }

  try {
    var token = getAccessToken_();
    var pid = requiredProp_("FIREBASE_PROJECT_ID");
    var posts = fetchBoardPosts_(pid, token);
    var tasks = posts.filter(function (p) { return !p.deleted && p.dueDate; });
    var linked = tasks.filter(function (p) { return p.calendarEventId; });
    out.push("OK      掲示板 " + posts.length + "件／チェックリスト " + tasks.length +
      "件（カレンダー連携済み " + linked.length + "件）");
  } catch (e) {
    out.push("失敗    Firestore 接続: " + e.message);
  }

  var installed = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  out.push((installed.indexOf("syncTaskCalendar") >= 0 ? "OK   " : "未設定") + "  トリガー syncTaskCalendar");
  out.push((installed.indexOf("remindDueTasks") >= 0 ? "OK   " : "未設定") + "  トリガー remindDueTasks");

  Logger.log(out.join("\n"));
  return out.join("\n");
}

/**
 * 「カレンダーに出ない」を切り分ける。
 * チェックリストの一覧と、予定IDを持っているかどうかを並べて出す。
 */
function whyNoCalendar() {
  var token = getAccessToken_();
  var pid = requiredProp_("FIREBASE_PROJECT_ID");
  var calId = PropertiesService.getScriptProperties().getProperty("TASK_CALENDAR_ID");
  var cal = calId ? CalendarApp.getCalendarById(calId) : null;
  var out = [];

  out.push("カレンダー: " + (cal ? cal.getName() : "未設定または見つかりません"));
  out.push("");

  var posts = fetchBoardPosts_(pid, token);
  var tasks = posts.filter(function (p) { return p.dueDate; });
  if (!tasks.length) {
    out.push("期日が入っている投稿が1件もありません。");
    out.push("（アプリの掲示板で「期日」を入れて投稿すると、ここに出ます）");
  }
  tasks.forEach(function (p) {
    var mark;
    if (p.deleted) mark = "削除済みのため予定なし";
    else if (!p.calendarEventId) mark = "★ 未連携（次の syncTaskCalendar で作られます）";
    else if (!cal) mark = "ID あり（カレンダーが読めないため確認できません）";
    else mark = cal.getEventById(p.calendarEventId) ? "連携済み" : "IDはあるが予定が無い（作り直されます）";
    out.push("  " + p.dueDate + "  " + p.title + "  → " + mark);
  });

  Logger.log(out.join("\n"));
  return out.join("\n");
}

/** 予定をすべて外して作り直す。取り違えが起きたときの最後の手段 */
function relinkAllTaskEvents() {
  var token = getAccessToken_();
  var pid = requiredProp_("FIREBASE_PROJECT_ID");
  var cal = CalendarApp.getCalendarById(requiredProp_("TASK_CALENDAR_ID"));
  if (!cal) throw new Error("カレンダーが見つかりません");

  var n = 0;
  fetchBoardPosts_(pid, token).forEach(function (p) {
    if (!p.calendarEventId) return;
    var ev = cal.getEventById(p.calendarEventId);
    if (ev) ev.deleteEvent();
    patchFieldsChecked_(pid, token, "boardPosts/" + p.id, { calendarEventId: null });
    n++;
  });
  Logger.log(n + "件の紐付けを外しました。syncTaskCalendar を実行すると作り直されます");
}
