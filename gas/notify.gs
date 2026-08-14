/**
 * 第二CC Hub — 新着を Google Chat のスペースに通知
 * ============================================================================
 * sync.gs と同じ Apps Script プロジェクトに置いてください。
 * 認証まわり（getAccessToken_ / fsBase_ / requiredProp_ など）は
 * sync.gs のものをそのまま使います。単独では動きません。
 *
 * 【なぜブラウザから送らないか】
 * Chat の Webhook URL は、それを知っている人なら誰でもそのスペースへ
 * 投稿できる鍵です。公開リポジトリのアプリに埋め込むわけにはいかず、
 * そもそも Chat の Webhook はブラウザからの呼び出しを許可していません。
 * サーバー側（GAS）から送る以外に選択肢がありません。
 *
 * 【このファイルに書いてはいけないもの】
 *   - Webhook URL（スクリプトプロパティ CHAT_WEBHOOK_URL に置く）
 *   - 社員の氏名（Firestore の members から取得する）
 * ============================================================================
 */

// 通知する時間帯。深夜に鳴らしても誰も動けないので、
// 夜間の投稿は翌朝の最初の実行でまとめて流す。
var NOTIFY_HOUR_FROM = 8;
var NOTIFY_HOUR_TO   = 22;

var APP_URL = "https://kaiseiiiiiii.github.io/daini-cc-hub/";

// 1回で流す最大件数。まとめて増えたときにスペースを埋め尽くさないため。
var NOTIFY_MAX = 10;


// ══════════════════════════════════════════════════════════════════════
//  エントリポイント
// ══════════════════════════════════════════════════════════════════════

/** 時間主導型トリガー（5分おき）から呼ばれる */
function notifyNewPosts() {
  var hour = Number(Utilities.formatDate(new Date(), TZ, "H"));
  if (hour < NOTIFY_HOUR_FROM || hour > NOTIFY_HOUR_TO) return;
  runNotify("trigger");
}

/** 手動実行用 */
function manualNotify() {
  runNotify("manual");
}

/**
 * 通知の起点を「いま」に合わせる。
 * 初回セットアップ時と、過去分を流したくないときに使う。
 */
function resetNotifyWatermark() {
  var token = getAccessToken_();
  var projectId = requiredProp_("FIREBASE_PROJECT_ID");
  var now = new Date();
  writeDoc_(projectId, token, "syncStatus/notify", {
    lastNotifiedAt: now,
    lastNotifiedAtMs: now.getTime(),
    lastResult: "reset",
    note: "ここより前の投稿は通知しません"
  });
  Logger.log("通知の起点を " + Utilities.formatDate(now, TZ, "yyyy-MM-dd HH:mm:ss") + " にしました");
}


// ══════════════════════════════════════════════════════════════════════
//  本体
// ══════════════════════════════════════════════════════════════════════

function runNotify(trigger) {
  var startedAt = new Date();
  var sent = 0;

  try {
    var webhook = requiredProp_("CHAT_WEBHOOK_URL");
    var token = getAccessToken_();
    var projectId = requiredProp_("FIREBASE_PROJECT_ID");

    var since = readWatermark_(projectId, token);
    if (since === null) {
      // 初回。ここまでの投稿を一気に流すと事故になるので、
      // 起点だけ置いて何も送らない。
      resetNotifyWatermark();
      notifyLog_("ok", trigger, new Date() - startedAt, 0,
        "初回のため起点だけ設定しました。次の投稿から通知します");
      return;
    }

    // 何件見て何件が新着だったかを残す。
    // 送らなかったときに「壊れているのか、単に新着が無いのか」を
    // ログだけで区別できるようにするため。
    var seen = { boardPosts: 0, surveys: 0 };
    var items = []
      .concat(collectNew_(projectId, token, "boardPosts", since, seen))
      .concat(collectNew_(projectId, token, "surveys", since, seen));

    var sinceText = Utilities.formatDate(new Date(since), TZ, "MM-dd HH:mm:ss");

    if (!items.length) {
      touchWatermark_(projectId, token, startedAt, 0, "");
      notifyLog_("ok", trigger, new Date() - startedAt, 0,
        "新着なし（起点 " + sinceText + " 以降／掲示板 " + seen.boardPosts +
        "件・アンケート " + seen.surveys + "件を確認）");
      return;
    }

    items.sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });
    var overflow = Math.max(0, items.length - NOTIFY_MAX);
    if (overflow) items = items.slice(0, NOTIFY_MAX);

    var names = fetchMemberIdNameMap_(projectId, token);
    postToChat_(webhook, buildMessage_(items, names, overflow));
    sent = items.length;

    touchWatermark_(projectId, token, startedAt, sent, "");
    notifyLog_("ok", trigger, new Date() - startedAt, sent,
      "送信しました（起点 " + sinceText + " 以降）");

  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    notifyLog_("error", trigger, new Date() - startedAt, sent, msg);
    throw e;
  }
}


// ══════════════════════════════════════════════════════════════════════
//  Firestore から新着を拾う
// ══════════════════════════════════════════════════════════════════════

/** 前回どこまで通知したか。未設定なら null */
function readWatermark_(projectId, token) {
  var res = UrlFetchApp.fetch(fsBase_(projectId) + "syncStatus/notify", {
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) {
    throw new Error("通知の起点を読めませんでした: " + res.getContentText());
  }
  var f = (JSON.parse(res.getContentText()).fields) || {};
  var ms = f.lastNotifiedAtMs && Number(f.lastNotifiedAtMs.integerValue);
  return ms ? ms : null;
}

function touchWatermark_(projectId, token, at, sent, error) {
  writeDoc_(projectId, token, "syncStatus/notify", {
    lastNotifiedAt: at,
    lastNotifiedAtMs: at.getTime(),
    lastResult: error ? "error" : "ok",
    lastError: error || "",
    lastSentCount: sent
  });
}

/**
 * 指定コレクションの新着を拾う。
 * 新しい順に少し多めに取って、こちら側で絞る。
 * 削除済みは通知しない（消したものが後から流れると混乱するため）。
 */
function collectNew_(projectId, token, col, sinceMs, seen) {
  var url = fsBase_(projectId) + col +
    "?pageSize=30&orderBy=" + encodeURIComponent("createdAt desc");
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(col + " を読めませんでした: " + res.getContentText());
  }
  var docs = (JSON.parse(res.getContentText()).documents) || [];
  if (seen) seen[col] = docs.length;
  var out = [];
  docs.forEach(function (d) {
    var f = d.fields || {};
    if (fsBool_(f.deleted)) return;
    var createdAt = f.createdAt && f.createdAt.timestampValue;
    if (!createdAt) return;
    var ms = new Date(createdAt).getTime();
    if (!(ms > sinceMs)) return;
    out.push({
      kind: col,
      createdAtMs: ms,
      authorId: fsStr_(f.authorId),
      title: fsStr_(f.title),
      category: fsStr_(f.category),
      pinned: fsBool_(f.pinned),
      multi: fsBool_(f.multi),
      deadline: fsStr_(f.deadline)
    });
  });
  return out;
}

function fsStr_(v) { return (v && v.stringValue) ? v.stringValue : ""; }
function fsBool_(v) { return !!(v && v.booleanValue); }

/** memberId → 表示名 */
function fetchMemberIdNameMap_(projectId, token) {
  var map = {};
  var res = UrlFetchApp.fetch(fsBase_(projectId) + "members?pageSize=300", {
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return map;
  ((JSON.parse(res.getContentText()).documents) || []).forEach(function (d) {
    var f = d.fields || {};
    var id = fsStr_(f.memberId), name = fsStr_(f.displayName);
    if (id) map[id] = name || id;
  });
  return map;
}


// ══════════════════════════════════════════════════════════════════════
//  メッセージ
// ══════════════════════════════════════════════════════════════════════

/**
 * 1件ずつ送らず、1回の実行分をまとめて1通にする。
 * 5分おきに何通も鳴ると、そのうち誰も見なくなるため。
 */
function buildMessage_(items, names, overflow) {
  var lines = [];
  var boards = items.filter(function (i) { return i.kind === "boardPosts"; });
  var surveys = items.filter(function (i) { return i.kind === "surveys"; });

  if (boards.length) {
    lines.push("*掲示板に " + boards.length + "件*");
    boards.forEach(function (b) {
      var head = b.pinned ? "📌 " : "";
      var cat = b.category ? "［" + b.category + "］" : "";
      lines.push("• " + head + cat + b.title + "  — " + (names[b.authorId] || "?"));
    });
  }

  if (surveys.length) {
    if (lines.length) lines.push("");
    lines.push("*アンケートが " + surveys.length + "件*");
    surveys.forEach(function (s) {
      var meta = [];
      if (s.deadline) meta.push("期限 " + s.deadline);
      meta.push(s.multi ? "複数選択" : "単一選択");
      lines.push("• " + s.title + "（" + meta.join("・") + "）  — " + (names[s.authorId] || "?"));
    });
  }

  if (overflow) {
    lines.push("");
    lines.push("ほか " + overflow + "件。アプリで確認してください。");
  }

  lines.push("");
  lines.push("<" + APP_URL + "|第二CC Hub を開く>");
  return lines.join("\n");
}

function postToChat_(webhook, text) {
  var res = UrlFetchApp.fetch(webhook, {
    method: "post",
    contentType: "application/json; charset=UTF-8",
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error("Chat への送信に失敗: " + res.getResponseCode() + " " + res.getContentText());
  }
}


// ══════════════════════════════════════════════════════════════════════
//  ログとセットアップ
// ══════════════════════════════════════════════════════════════════════

function notifyLog_(result, trigger, durationMs, sent, errorMessage) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("_notify_log");
    if (!sheet) {
      sheet = ss.insertSheet("_notify_log");
      sheet.appendRow(["実行時刻", "結果", "きっかけ", "所要(ms)", "送信件数", "エラー"]);
    }
    sheet.appendRow([
      Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss"),
      result, trigger, durationMs, sent, errorMessage || ""
    ]);
    var extra = sheet.getLastRow() - 501;
    if (extra > 0) sheet.deleteRows(2, extra);
  } catch (e) {
    Logger.log("通知ログの書き込みに失敗: " + e);
  }
}

/** 5分おきのトリガーを作り直す。1度だけ実行すればよい */
function installNotifyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "notifyNewPosts") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("notifyNewPosts").timeBased().everyMinutes(5).create();
  Logger.log("5分おきの通知トリガーを設定しました");
}

/** 設定確認。セットアップ直後に実行する */
function checkNotifySetup() {
  var out = [];
  var props = PropertiesService.getScriptProperties();
  out.push((props.getProperty("CHAT_WEBHOOK_URL") ? "OK   " : "未設定") + "  スクリプトプロパティ CHAT_WEBHOOK_URL");
  out.push((props.getProperty("FIREBASE_PROJECT_ID") ? "OK   " : "未設定") + "  スクリプトプロパティ FIREBASE_PROJECT_ID");
  try {
    var token = getAccessToken_();
    var pid = props.getProperty("FIREBASE_PROJECT_ID");
    var wm = readWatermark_(pid, token);
    out.push(wm === null
      ? "未設定  通知の起点（resetNotifyWatermark を1度実行してください）"
      : "OK      通知の起点 " + Utilities.formatDate(new Date(wm), TZ, "yyyy-MM-dd HH:mm:ss"));
    out.push("OK      members " + Object.keys(fetchMemberIdNameMap_(pid, token)).length + "名");
  } catch (e) {
    out.push("失敗    Firestore 接続: " + e.message);
  }
  Logger.log(out.join("\n"));
  return out.join("\n");
}

/**
 * 「投稿したのに来ない」を切り分ける。
 * 通知の起点と、直近の投稿の時刻を並べて出すだけ。
 * 起点より古い投稿は対象外なので、それが一目で分かる。
 */
function whyNoNotify() {
  var token = getAccessToken_();
  var pid = requiredProp_("FIREBASE_PROJECT_ID");
  var since = readWatermark_(pid, token);
  var out = [];

  out.push("通知の起点: " + (since === null
    ? "未設定（resetNotifyWatermark を実行してください）"
    : Utilities.formatDate(new Date(since), TZ, "yyyy-MM-dd HH:mm:ss")));
  out.push("");

  ["boardPosts", "surveys"].forEach(function (col) {
    var url = fsBase_(pid) + col + "?pageSize=5&orderBy=" + encodeURIComponent("createdAt desc");
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true
    });
    out.push("── " + col + " HTTP " + res.getResponseCode() + " ──");
    if (res.getResponseCode() !== 200) { out.push(res.getContentText().slice(0, 300)); return; }
    var docs = (JSON.parse(res.getContentText()).documents) || [];
    if (!docs.length) { out.push("  （1件もありません）"); return; }
    docs.forEach(function (d) {
      var f = d.fields || {};
      var ts = f.createdAt && f.createdAt.timestampValue;
      var ms = ts ? new Date(ts).getTime() : 0;
      var mark = !ts ? "createdAt なし"
        : (fsBool_(f.deleted) ? "削除済みのため対象外"
        : (since !== null && ms > since ? "★ 通知対象" : "起点より前のため対象外"));
      out.push("  " + (ts ? Utilities.formatDate(new Date(ts), TZ, "MM-dd HH:mm:ss") : "--")
        + "  " + (fsStr_(f.title) || "(無題)") + "  → " + mark);
    });
  });

  Logger.log(out.join("\n"));
  return out.join("\n");
}

/** テスト送信。スペースに届くかだけ確かめる */
function sendTestMessage() {
  postToChat_(requiredProp_("CHAT_WEBHOOK_URL"),
    "第二CC Hub の通知テストです。この後、掲示板とアンケートの新着がここに届きます。\n" +
    "<" + APP_URL + "|第二CC Hub を開く>");
  Logger.log("テスト送信しました");
}
