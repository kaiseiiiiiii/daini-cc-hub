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
      // 非公開の投稿は Chat に出さない。スペースは全員が読めるので、
      // 題名を流した時点で非公開の意味がなくなる。
      // サービスアカウントはルールを迂回して読めてしまうため、
      // ここで明示的に外す必要がある（読めないから安全、にはならない）。
      return !p.deleted && p.dueDate && !isPrivatePost_(p);
    });
    var names = fetchMemberIdNameMap_(projectId, token);
    var activeIds = fetchActiveMemberIds_(projectId, token);

    // 「タスク×期日」を1件として組み立てる。人ごとに期日が違う場合、
    // タスク単位で判定すると、別日を割り振られた人を間違った日に催促する。
    var buckets = { overdue: [], today: [], tomorrow: [] };
    posts.forEach(function (p) {
      var pending = pendingMemberIds_(p, activeIds);
      if (!pending.length) return;                       // 全員終わっているものは促さない

      // 期日ごとに未完了者をまとめる
      var byDate = {};
      pending.forEach(function (id) {
        var ymd = memberDue_(p, id);
        if (!ymd) return;
        (byDate[ymd] = byDate[ymd] || []).push(id);
      });

      Object.keys(byDate).forEach(function (ymd) {
        var left = daysLeft_(ymd);
        if (left === null) return;
        var row = { post: p, pending: byDate[ymd], left: left,
                    ymd: ymd, named: hasPerMemberDue_(p) };
        if (left === 0) buckets.today.push(row);
        else if (left === 1) buckets.tomorrow.push(row);
        else if (left < 0 && left >= -OVERDUE_REMIND_DAYS) buckets.overdue.push(row);
      });
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
    doneBy: fsMapKeys_(f.doneBy),
    dueBy: fsStrMap_(f.dueBy),                  // 人ごとの期日（例外だけ）
    visibleTo: fsStrList_(f.visibleTo)          // 読める人。["*"] は全員
  };
}

/**
 * 非公開の投稿か。visibleTo に "*" が無く、中身がある場合。
 * visibleTo そのものが無い（移行前）投稿は公開扱い。
 */
function isPrivatePost_(post) {
  var v = post.visibleTo || [];
  return v.length > 0 && v.indexOf("*") < 0;
}

/** マップフィールドを {キー: 文字列} にする。dueBy の取り出しに使う */
function fsStrMap_(v) {
  var out = {};
  if (!v || !v.mapValue || !v.mapValue.fields) return out;
  var f = v.mapValue.fields;
  Object.keys(f).forEach(function (k) {
    var s = f[k] && f[k].stringValue;
    if (s) out[k] = s;
  });
  return out;
}

/**
 * その人の期日。dueBy に本人の分があればそれ、無ければ全体の期日。
 * アプリ側の memberDue と同じ規則。
 */
function memberDue_(post, memberId) {
  return post.dueBy[memberId] || post.dueDate || "";
}

function hasPerMemberDue_(post) {
  return Object.keys(post.dueBy).length > 0;
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
    // 人ごとに期日を割り振ってある場合は、その日付も出す。
    // 同じタスクが別の日付で何度も並ぶので、日付が無いと区別が付かない。
    var when = r.named ? "［" + r.ymd + "］" : "";
    lines.push("• " + r.post.title + when + suffix +
      " — 未完了 " + r.pending.length + "名: " + who);
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

/**
 * 【移行用・一度だけ実行】既存の掲示板投稿すべてに visibleTo: ["*"]（全員公開）を入れる。
 *
 * 非公開タスクの仕組みは、アプリ側が
 *   where("visibleTo", "array-contains-any", ["*", 自分のID])
 * で絞り込む前提になっている。visibleTo を持たない投稿はこの条件に
 * 引っかからないため、入れておかないと**既存の投稿が一覧から消える**。
 *
 * 消す操作は一切していない。すでに visibleTo を持つ投稿には触らない。
 * 何度実行しても結果は同じ（べき等）。
 *
 * 順番: これを実行 → 複合インデックスを作成 → 新しいコードを反映 → ルールを公開
 */
function backfillVisibility() {
  var token = getAccessToken_();
  var pid = requiredProp_("FIREBASE_PROJECT_ID");
  var posts = fetchBoardPosts_(pid, token);

  var already = 0, wrote = 0, failed = 0;
  posts.forEach(function (p) {
    if (p.visibleTo.length > 0) { already++; return; }
    try {
      patchFieldsChecked_(pid, token, "boardPosts/" + p.id, { visibleTo: ["*"] });
      wrote++;
    } catch (e) {
      failed++;
      Logger.log("失敗 " + p.id + " (" + p.title + "): " + ((e && e.message) || e));
    }
  });

  var msg = "掲示板 " + posts.length + "件のうち、" +
    wrote + "件に「全員公開」を入れました（既に設定済み " + already + "件・失敗 " + failed + "件）";
  taskLog_(failed ? "error" : "ok", "backfill", 0, msg);
  Logger.log(msg);
  if (failed) {
    Logger.log("失敗が残っています。もう一度実行してから次の手順に進んでください。");
  } else {
    Logger.log("次は複合インデックスの作成です。docs/checklist-setup.md を参照してください。");
  }
  return msg;
}

/**
 * 一部のフィールドだけ更新する。失敗したら必ず例外にする。
 * 移行で黙って失敗すると、その投稿だけ一覧から消えたまま気づけない。
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

/** 移行の結果を確認する。非公開の投稿が何件あるかも出す */
function checkVisibility() {
  var token = getAccessToken_();
  var pid = requiredProp_("FIREBASE_PROJECT_ID");
  var posts = fetchBoardPosts_(pid, token);
  var missing = posts.filter(function (p) { return p.visibleTo.length === 0; });
  var priv = posts.filter(isPrivatePost_);
  var out = [];
  out.push("掲示板 " + posts.length + "件");
  out.push((missing.length ? "要移行  " : "OK      ") +
    "visibleTo が無い投稿 " + missing.length + "件" +
    (missing.length ? "（backfillVisibility を実行してください）" : ""));
  out.push("        非公開の投稿 " + priv.length + "件（Chat には流しません）");
  missing.slice(0, 10).forEach(function (p) { out.push("        未設定: " + p.title); });
  Logger.log(out.join("\n"));
  return out.join("\n");
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
    var pending = pendingMemberIds_(p, activeIds);
    if (p.deleted) { out.push("  " + p.dueDate + "  " + p.title + "  → 削除済みのため対象外"); return; }
    if (isPrivatePost_(p)) { out.push("  " + p.dueDate + "  " + p.title + "  → 非公開のため Chat には出しません"); return; }
    if (!pending.length) { out.push("  " + p.dueDate + "  " + p.title + "  → 全員完了のため対象外"); return; }

    // 人ごとに期日が違う場合は、期日ごとに分けて出す
    var byDate = {};
    pending.forEach(function (id) {
      var ymd = memberDue_(p, id);
      (byDate[ymd || "(期日なし)"] = byDate[ymd || "(期日なし)"] || []).push(id);
    });

    Object.keys(byDate).sort().forEach(function (ymd) {
      var left = daysLeft_(ymd);
      var mark;
      if (left === null) mark = "期日の形が不正なため対象外";
      else if (left === 0) mark = "★ 本日まで";
      else if (left === 1) mark = "★ 明日まで";
      else if (left < 0 && left >= -OVERDUE_REMIND_DAYS) mark = "★ 期限切れ（" + (-left) + "日超過）";
      else if (left < 0) mark = (-left) + "日超過。" + OVERDUE_REMIND_DAYS + "日を過ぎたため対象外";
      else mark = "まだ " + left + "日あるため対象外";
      var who = byDate[ymd].map(function (id) { return names[id] || id; }).join("・");
      out.push("  " + ymd + "  " + p.title + "  → " + mark +
        "（未完了 " + byDate[ymd].length + "名: " + who + "）");
    });
  });

  Logger.log(out.join("\n"));
  return out.join("\n");
}
