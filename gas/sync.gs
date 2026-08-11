/**
 * 第二CC Hub — スプレッドシート → Firestore 同期
 * ============================================================================
 * このスクリプトは「同期用スプレッドシート」にコンテナバインドで置きます。
 * 読むのは SpreadsheetApp.getActiveSpreadsheet()、つまり自分が乗っている
 * ファイルだけです。原本のファイルIDはこのコードのどこにも出てきません。
 *
 * 原本のデータは、同期用スプレッドシート側の IMPORTRANGE が引いてきます。
 * IMPORTRANGE は読み取り専用の関数なので、この構成では
 * 原本を書き換える経路が仕組みとして存在しません。
 *
 * 【このファイルに書いてはいけないもの】
 *   - サービスアカウント鍵（スクリプトプロパティに置く）
 *   - 原本スプレッドシートのID（同期用シートの cfg タブに置く）
 *   - 社員の氏名（Firestore の members から取得する）
 *   このファイルは公開リポジトリに入ります。
 *
 * セットアップ手順は README.md の「Phase 5: スプレッドシート同期」を参照。
 * ============================================================================
 */

// ── 設定 ────────────────────────────────────────────────────────────
var TZ = "Asia/Tokyo";

// 同期する時間帯（この時刻の「台」に入っていれば実行する）
// 実績データは10時に更新が始まり、21時30分が最終更新。
// 22時台の実行で当日分を締める。深夜・早朝は同じ数字を取り直すだけなので走らせない。
var SYNC_HOUR_FROM = 10;
var SYNC_HOUR_TO   = 22;

// 同期用スプレッドシートのタブ名（README の手順で作るもの）
var TAB = {
  cfg:          "cfg",
  shiftPrev:    "shift_prev",
  shiftCur:     "shift_cur",
  shiftNext:    "shift_next",
  productivity: "productivity",
  goalAll:      "goal_all",
  goalTeamA:    "goal_team_a",
  goalTeamB:    "goal_team_b",
  goalOther:    "goal_other",
  log:          "_log"
};

// 生産性シートの列（1始まり）。A列が氏名。
var PROD_COL = {
  name: 1, v2id: 2,
  call_rate: 3, ancillary_rate: 4, wait_rate: 5, work_rate: 6,
  avg_call: 7, new_call: 8, hold: 9,
  handled: 10, connected: 11, unconnected: 12, connect_rate: 13
};

// 手配粗利額シートの列（1始まり）
var GOAL_COL = {
  weekday: 1, date: 2,
  dailyTarget: 3, dailyActual: 4, dailyRate: 5,
  weeklyTarget: 6, weeklyActual: 7, weeklyRate: 8,
  monthTarget: 9, monthActual: 10, monthRate: 11
};

// IMPORTRANGE が解決できていないときにセルへ入る値。
// これを掴んだまま書き込むと、画面に嘘の数字が出るので必ず中断する。
var UNRESOLVED = ["#REF!", "#N/A", "#ERROR!", "Loading...", "読み込んでいます..."];


// ══════════════════════════════════════════════════════════════════════
//  エントリポイント
// ══════════════════════════════════════════════════════════════════════

/** 時間主導型トリガー（毎時）から呼ばれる */
function hourlySync() {
  var hour = Number(Utilities.formatDate(new Date(), TZ, "H"));
  if (hour < SYNC_HOUR_FROM || hour > SYNC_HOUR_TO) {
    // 範囲外は即終了。ログにも残さない（毎日11行の無意味な行が増えるだけなので）
    return;
  }
  runSync("trigger");
}

/** 手動実行用。エディタから直接動かして確認するとき使う */
function manualSync() {
  runSync("manual");
}

/** 時間帯チェックを飛ばして必ず実行する。障害復旧などの緊急時のみ */
function forceSync() {
  runSync("force");
}


// ══════════════════════════════════════════════════════════════════════
//  本体
// ══════════════════════════════════════════════════════════════════════

function runSync(trigger) {
  var startedAt = new Date();
  var counts = { shiftMonths: 0, members: 0, goalTeams: 0, unmatched: [] };

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var token = getAccessToken_();
    var projectId = requiredProp_("FIREBASE_PROJECT_ID");

    // 氏名からメンバーIDを引く表を Firestore から取る。
    // 氏名をこのコードに書かないための取り回し。
    var nameToId = fetchMemberNameMap_(projectId, token);
    counts.members = Object.keys(nameToId).length;
    if (!counts.members) throw new Error("members が1件も取得できませんでした");

    // ── シフト（前月・当月・翌月）──────────────────────────────
    var months = [
      { tab: TAB.shiftPrev, offset: -1 },
      { tab: TAB.shiftCur,  offset: 0 },
      { tab: TAB.shiftNext, offset: 1 }
    ];
    months.forEach(function (m) {
      var monthId = monthIdOf_(m.offset);
      var shift = readShift_(ss, m.tab, nameToId, counts);
      if (!shift) return;   // 未作成の月。エラーにはしない
      shift.monthId = monthId;
      writeDoc_(projectId, token, "shifts/" + monthId, shift);
      counts.shiftMonths++;
    });

    // ── 生産性KPI ────────────────────────────────────────────
    var metrics = readProductivity_(ss, nameToId, counts);
    writeDoc_(projectId, token, "metrics/latest", metrics);

    // ── 目標・実績（手配粗利額）──────────────────────────────
    var goals = { monthId: monthIdOf_(0), teams: {} };
    [
      { tab: TAB.goalAll,   key: "all" },
      { tab: TAB.goalTeamA, key: "team_a" },
      { tab: TAB.goalTeamB, key: "team_b" },
      { tab: TAB.goalOther, key: "other" }
    ].forEach(function (g) {
      var days = readGoal_(ss, g.tab);
      if (!days) return;
      goals.teams[g.key] = { days: days };
      counts.goalTeams++;
    });
    writeDoc_(projectId, token, "goals/current", goals);

    // ── 同期ステータス ────────────────────────────────────────
    var finishedAt = new Date();
    var durationMs = finishedAt.getTime() - startedAt.getTime();
    writeDoc_(projectId, token, "syncStatus/spreadsheet", {
      lastSyncedAt: finishedAt,
      lastSyncedAtLabel: Utilities.formatDate(finishedAt, TZ, "M月d日 H時mm分"),
      lastResult: "ok",
      lastError: "",
      durationMs: durationMs,
      trigger: trigger,
      shiftMonths: counts.shiftMonths,
      memberCount: counts.members,
      goalTeams: counts.goalTeams,
      unmatchedNames: counts.unmatched
    });

    log_(ss, "ok", trigger, durationMs, counts, "");

  } catch (e) {
    var ms = new Date().getTime() - startedAt.getTime();
    var msg = (e && e.message) ? e.message : String(e);
    log_(SpreadsheetApp.getActiveSpreadsheet(), "error", trigger, ms, counts, msg);

    // 失敗そのものも Firestore に残す。
    // ここを書けないほど壊れている場合は、画面側の経過時間判定が拾う。
    try {
      var pid = PropertiesService.getScriptProperties().getProperty("FIREBASE_PROJECT_ID");
      var tk = getAccessToken_();
      patchFields_(pid, tk, "syncStatus/spreadsheet", {
        lastResult: "error",
        lastError: msg,
        lastErrorAt: new Date()
      });
    } catch (ignored) {}

    throw e;   // Apps Script の実行ログにも残す
  }
}


// ══════════════════════════════════════════════════════════════════════
//  シートの読み取り
// ══════════════════════════════════════════════════════════════════════

/**
 * IMPORTRANGE が解決できていないセルが混ざっていないか。
 *
 * cols（1始まりの列番号の配列）を渡すと、その列だけを検査する。
 *
 * #REF! には意味が2種類あり、区別しないと誤検知する。
 *   1. タブ全体が #REF!  → IMPORTRANGE そのものの失敗（アクセス許可切れなど）
 *   2. 一部のセルだけ #REF! → IMPORTRANGE は成功していて、原本側の数式が壊れている
 *
 * 1 は呼び出し側の hasUnresolvedRefOnly_ が先に捕捉する。
 * 2 で全体を止めると、読み取りもしない列（達成率など）の数式エラーだけで
 * 毎時の同期が丸ごと失敗し続ける。実際に手配粗利額の原本では、
 * 未作成の週を参照している達成率セルが #REF! になっていた。
 * そのため、実際に読む列だけを検査できるようにしている。
 */
function assertResolved_(values, tabName, cols) {
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (cols && cols.indexOf(c + 1) < 0) continue;
      var v = values[r][c];
      if (typeof v === "string" && UNRESOLVED.indexOf(v.trim()) >= 0) {
        throw new Error(tabName + " の " + (c + 1) + " 列目に " + v.trim() + " があります。" +
          "タブ全体が #REF! なら IMPORTRANGE のアクセス許可を、" +
          "一部のセルだけなら原本の数式を確認してください。");
      }
    }
  }
}

/** 空タブ（＝その月のシートがまだ無い）かどうか */
function isEmptyTab_(values) {
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (String(values[r][c]).trim() !== "") return false;
    }
  }
  return true;
}

/**
 * シフト表を読む。
 * 行位置を決め打ちにせず、B列が「日」の行を日付行として探す。
 * 原本に行が挿入されても壊れないようにするため。
 */
function readShift_(ss, tabName, nameToId, counts) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error("タブ " + tabName + " がありません");
  var values = sheet.getDataRange().getValues();

  // 翌月分はまだ作られていないことが普通にある。
  // その場合 IMPORTRANGE は #REF! になるので、空扱いにして飛ばす。
  if (isEmptyTab_(values)) return null;
  if (hasUnresolvedRefOnly_(values)) return null;
  assertResolved_(values, tabName);

  var dateRow = -1, weekdayRow = -1;
  for (var r = 0; r < values.length; r++) {
    var b = String(values[r][1]).trim();
    if (b === "日" && dateRow < 0) dateRow = r;
    if (b === "曜日" && dateRow >= 0 && weekdayRow < 0) weekdayRow = r;
  }
  if (dateRow < 0) throw new Error(tabName + ": 日付行（B列が「日」）が見つかりません");

  var dates = [], weekdays = [];
  for (var c = 2; c < values[dateRow].length; c++) {
    var d = values[dateRow][c];
    if (d === "" || d === null) break;
    dates.push(formatDateCell_(d));
    weekdays.push(weekdayRow >= 0 ? String(values[weekdayRow][c]).trim() : "");
  }
  if (!dates.length) throw new Error(tabName + ": 日付が読み取れません");

  var rows = {};
  var startRow = (weekdayRow >= 0 ? weekdayRow : dateRow) + 1;
  for (var r2 = startRow; r2 < values.length; r2++) {
    var name = normalizeName_(values[r2][1]);
    if (!name) continue;
    var memberId = nameToId[name];
    if (!memberId) {
      // 第二CC以外の拠点の人が同じ表に載っている。想定内なので黙って飛ばす。
      // ただし件数だけは syncStatus に残し、氏名の取り違えに気づけるようにする。
      if (counts.unmatched.indexOf(name) < 0 && counts.unmatched.length < 50) {
        counts.unmatched.push(name);
      }
      continue;
    }
    var line = [];
    for (var c2 = 2; c2 < 2 + dates.length; c2++) {
      line.push(String(values[r2][c2] == null ? "" : values[r2][c2]).trim());
    }
    rows[memberId] = line;
  }

  return { dates: dates, weekdays: weekdays, rows: rows };
}

/** #REF! だけで埋まっているタブか（＝その月のシートが原本に無い） */
function hasUnresolvedRefOnly_(values) {
  var seen = false;
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var v = String(values[r][c]).trim();
      if (v === "") continue;
      if (v === "#REF!" || v === "#N/A") { seen = true; continue; }
      return false;   // ほかの値があるなら本物のデータ
    }
  }
  return seen;
}

/**
 * 生産性KPI を読む。
 * このシートはチームごとにヘッダーが繰り返される作りなので、
 * 行位置ではなく「A列がメンバーの氏名と一致する行」を拾う。
 */
function readProductivity_(ss, nameToId, counts) {
  var sheet = ss.getSheetByName(TAB.productivity);
  if (!sheet) throw new Error("タブ " + TAB.productivity + " がありません");
  var values = sheet.getDataRange().getValues();
  assertResolved_(values, TAB.productivity);

  var byMember = {};
  for (var r = 0; r < values.length; r++) {
    var name = normalizeName_(values[r][PROD_COL.name - 1]);
    if (!name) continue;
    var memberId = nameToId[name];
    if (!memberId) continue;

    var m = {
      call_rate:      toRate_(values[r][PROD_COL.call_rate - 1]),
      ancillary_rate: toRate_(values[r][PROD_COL.ancillary_rate - 1]),
      wait_rate:      toRate_(values[r][PROD_COL.wait_rate - 1]),
      work_rate:      toRate_(values[r][PROD_COL.work_rate - 1]),
      avg_call:       toMinutes_(values[r][PROD_COL.avg_call - 1]),
      handled:        toNumber_(values[r][PROD_COL.handled - 1]),
      connect_rate:   toRate_(values[r][PROD_COL.connect_rate - 1])
    };
    // 値が1つも無い行（名前だけ入っている枠）は書かない
    var hasAny = false;
    for (var k in m) if (m[k] !== null) hasAny = true;
    if (hasAny) byMember[memberId] = m;
  }

  return { byMember: byMember, memberCount: Object.keys(byMember).length };
}

/** 手配粗利額の目標・実績を読む（1チーム分＝1タブ） */
function readGoal_(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return null;
  var values = sheet.getDataRange().getValues();
  if (isEmptyTab_(values)) return null;
  if (hasUnresolvedRefOnly_(values)) return null;
  // 実際に読む列だけを検査する。
  // 達成率（Daily/Weekly/Monthly）は読まないので、そこが #REF! でも同期を止めない。
  assertResolved_(values, tabName, [
    GOAL_COL.weekday, GOAL_COL.date,
    GOAL_COL.dailyTarget, GOAL_COL.dailyActual,
    GOAL_COL.monthTarget, GOAL_COL.monthActual
  ]);

  var days = [];
  for (var r = 0; r < values.length; r++) {
    var dateCell = values[r][GOAL_COL.date - 1];
    if (dateCell === "" || dateCell === null) continue;
    var label = formatDateCell_(dateCell);
    if (!/^\d{1,2}\/\d{1,2}$/.test(label)) continue;   // ヘッダー行を弾く
    days.push({
      date:        label,
      weekday:     String(values[r][GOAL_COL.weekday - 1] || "").trim(),
      dailyTarget: toNumber_(values[r][GOAL_COL.dailyTarget - 1]),
      dailyActual: toNumber_(values[r][GOAL_COL.dailyActual - 1]),
      monthTarget: toNumber_(values[r][GOAL_COL.monthTarget - 1]),
      monthActual: toNumber_(values[r][GOAL_COL.monthActual - 1])
    });
  }
  return days.length ? days : null;
}


// ══════════════════════════════════════════════════════════════════════
//  値の変換
// ══════════════════════════════════════════════════════════════════════

/**
 * 氏名の突き合わせキー。空白をすべて落として比較する。
 * 姓名の間の空白が、原本によって半角だったり全角だったりするため。
 */
function normalizeName_(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[\s　]/g, "").trim();
}

/** 日付セルを "M/D" に揃える（日付型でも文字列でも受ける） */
function formatDateCell_(v) {
  if (v instanceof Date) return (v.getMonth() + 1) + "/" + v.getDate();
  return String(v).trim();
}

/** 率。0.45 でも "45%" でも 45 でも、45 という数値にして返す */
function toRate_(v) {
  if (v === "" || v === null || v === undefined) return null;
  if (typeof v === "number") return Math.round((v <= 1 ? v * 100 : v) * 10) / 10;
  var s = String(v).replace("%", "").trim();
  if (s === "" || isNaN(Number(s))) return null;
  var n = Number(s);
  return Math.round((String(v).indexOf("%") >= 0 || n > 1 ? n : n * 100) * 10) / 10;
}

/** 時間（0:05:00 など）を分に直す。数値ならそのまま分とみなす */
function toMinutes_(v) {
  if (v === "" || v === null || v === undefined) return null;
  if (v instanceof Date) {
    return Math.round((v.getHours() * 60 + v.getMinutes() + v.getSeconds() / 60) * 10) / 10;
  }
  if (typeof v === "number") {
    // シリアル値（1 = 24時間）で来ることがある
    if (v > 0 && v < 1) return Math.round(v * 24 * 60 * 10) / 10;
    return Math.round(v * 10) / 10;
  }
  var parts = String(v).trim().split(":");
  if (parts.length === 3) {
    return Math.round((Number(parts[0]) * 60 + Number(parts[1]) + Number(parts[2]) / 60) * 10) / 10;
  }
  if (parts.length === 2) {
    return Math.round((Number(parts[0]) + Number(parts[1]) / 60) * 10) / 10;
  }
  var n = Number(v);
  return isNaN(n) ? null : n;
}

/** 数値。カンマ・円マーク付きの文字列も受ける */
function toNumber_(v) {
  if (v === "" || v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  var s = String(v).replace(/[,¥￥\s]/g, "").trim();
  if (s === "" || isNaN(Number(s))) return null;
  return Number(s);
}

/** 当月から offset か月ずらした "YYYY_M" */
function monthIdOf_(offset) {
  var now = new Date();
  var d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return d.getFullYear() + "_" + (d.getMonth() + 1);
}


// ══════════════════════════════════════════════════════════════════════
//  Firestore REST
// ══════════════════════════════════════════════════════════════════════

function requiredProp_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error("スクリプトプロパティ " + key + " が設定されていません");
  return v;
}

/**
 * サービスアカウントで OAuth のアクセストークンを取る。
 * 鍵はスクリプトプロパティから読む。コードには絶対に置かない。
 * トークンは有効期限まで CacheService に置いて、毎回の往復を減らす。
 */
function getAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("fs_token");
  if (cached) return cached;

  var key = JSON.parse(requiredProp_("FIREBASE_SERVICE_ACCOUNT"));
  var now = Math.floor(Date.now() / 1000);
  var header = { alg: "RS256", typ: "JWT" };
  var claim = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  var toSign = base64url_(JSON.stringify(header)) + "." + base64url_(JSON.stringify(claim));
  var signature = Utilities.computeRsaSha256Signature(toSign, key.private_key);
  var jwt = toSign + "." + Utilities.base64EncodeWebSafe(signature).replace(/=+$/, "");

  var res = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error("アクセストークンの取得に失敗: " + res.getContentText());
  }
  var token = JSON.parse(res.getContentText()).access_token;
  cache.put("fs_token", token, 3000);   // 有効期限3600秒より短く
  return token;
}

function base64url_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(s).getBytes()).replace(/=+$/, "");
}

function fsBase_(projectId) {
  return "https://firestore.googleapis.com/v1/projects/" + projectId +
         "/databases/(default)/documents/";
}

/** Firestore の members から「正規化した氏名 → memberId」を作る */
function fetchMemberNameMap_(projectId, token) {
  var map = {};
  var pageToken = "";
  do {
    var url = fsBase_(projectId) + "members?pageSize=300" + (pageToken ? "&pageToken=" + pageToken : "");
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      throw new Error("members の取得に失敗: " + res.getContentText());
    }
    var body = JSON.parse(res.getContentText());
    (body.documents || []).forEach(function (d) {
      var f = d.fields || {};
      var full = f.fullName && f.fullName.stringValue;
      var id = f.memberId && f.memberId.stringValue;
      var active = f.active && f.active.booleanValue;
      if (full && id && active !== false) map[normalizeName_(full)] = id;
    });
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return map;
}

/** ドキュメントを丸ごと置き換える（差分は取らない。毎回そのまま上書き） */
function writeDoc_(projectId, token, path, obj) {
  var url = fsBase_(projectId) + path;
  var res = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ fields: toFsFields_(obj) }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error(path + " の書き込みに失敗: " + res.getContentText());
  }
}

/** 一部のフィールドだけ更新する（エラー記録用） */
function patchFields_(projectId, token, path, obj) {
  var keys = Object.keys(obj);
  var mask = keys.map(function (k) { return "updateMask.fieldPaths=" + encodeURIComponent(k); }).join("&");
  var url = fsBase_(projectId) + path + "?" + mask;
  UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ fields: toFsFields_(obj) }),
    muteHttpExceptions: true
  });
}

function toFsFields_(obj) {
  var fields = {};
  for (var k in obj) fields[k] = toFsValue_(obj[k]);
  return fields;
}

function toFsValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return (v === Math.floor(v) && Math.abs(v) < 9007199254740991)
      ? { integerValue: String(v) }
      : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFsValue_) } };
  }
  if (typeof v === "object") {
    return { mapValue: { fields: toFsFields_(v) } };
  }
  return { stringValue: String(v) };
}


// ══════════════════════════════════════════════════════════════════════
//  実行ログ
// ══════════════════════════════════════════════════════════════════════

/**
 * 同期用スプレッドシートの _log タブに1行足す。
 * Apps Script の実行ログは流れていくので、成功・失敗の履歴は
 * シートに残しておくほうが後から追いやすい。
 */
function log_(ss, result, trigger, durationMs, counts, errorMessage) {
  try {
    var sheet = ss.getSheetByName(TAB.log);
    if (!sheet) {
      sheet = ss.insertSheet(TAB.log);
      sheet.appendRow(["実行時刻", "結果", "きっかけ", "所要(ms)",
                       "シフト月数", "メンバー数", "目標チーム数", "未照合の氏名", "エラー"]);
    }
    sheet.appendRow([
      Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss"),
      result, trigger, durationMs,
      counts.shiftMonths, counts.members, counts.goalTeams,
      counts.unmatched.length, errorMessage || ""
    ]);
    // 増え続けないように古い行を落とす
    var max = 500;
    var extra = sheet.getLastRow() - (max + 1);
    if (extra > 0) sheet.deleteRows(2, extra);
  } catch (e) {
    Logger.log("ログ書き込みに失敗: " + e);
  }
}


// ══════════════════════════════════════════════════════════════════════
//  セットアップ補助
// ══════════════════════════════════════════════════════════════════════

/**
 * 毎時のトリガーを作り直す。1度だけ実行すればよい。
 * 実行時刻の分は Google 側が決めるため「毎時0分ちょうど」にはならず、
 * その時間内のどこかで走る。時間帯の判定は hourlySync 側で行っている。
 */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "hourlySync") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("hourlySync").timeBased().everyHours(1).create();
  Logger.log("毎時トリガーを設定しました");
}

/** 設定が揃っているかの自己診断。セットアップ直後に実行して確認する */
function checkSetup() {
  var out = [];
  var props = PropertiesService.getScriptProperties();

  ["FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT"].forEach(function (k) {
    out.push((props.getProperty(k) ? "OK   " : "未設定") + "  スクリプトプロパティ " + k);
  });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [TAB.cfg, TAB.shiftPrev, TAB.shiftCur, TAB.shiftNext, TAB.productivity,
   TAB.goalAll, TAB.goalTeamA, TAB.goalTeamB, TAB.goalOther].forEach(function (t) {
    var sheet = ss.getSheetByName(t);
    if (!sheet) { out.push("無し  タブ " + t); return; }
    var v = sheet.getDataRange().getValues();
    if (isEmptyTab_(v))            out.push("空    タブ " + t);
    else if (hasUnresolvedRefOnly_(v)) out.push("#REF! タブ " + t + "（原本にその月が無い場合は正常）");
    else                           out.push("OK    タブ " + t + "  " + v.length + "行");
  });

  try {
    var token = getAccessToken_();
    out.push(token ? "OK    アクセストークン取得" : "失敗  アクセストークン取得");
    var map = fetchMemberNameMap_(props.getProperty("FIREBASE_PROJECT_ID"), token);
    out.push("OK    members " + Object.keys(map).length + "名を取得");
  } catch (e) {
    out.push("失敗  Firestore 接続: " + e.message);
  }

  Logger.log(out.join("\n"));
  return out.join("\n");
}
