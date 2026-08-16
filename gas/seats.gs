/**
 * 第二CC Hub — 座席表の取り込み
 * ============================================================================
 * sync.gs / notify.gs と同じ Apps Script プロジェクトに置いてください。
 * 認証まわり（getAccessToken_ / fsBase_ / requiredProp_ / writeDoc_ など）は
 * sync.gs のものをそのまま使います。単独では動きません。
 *
 * 【sync.gs と作りが違う点。必ず読むこと】
 * sync.gs は自分が乗っているスプレッドシートしか開きません。原本は
 * IMPORTRANGE 経由で引いており、原本を書き換える経路が仕組みとして
 * 存在しない、という作りになっています。
 *
 * このファイルだけは**原本を直接開きます**（SpreadsheetApp.openById）。
 * 理由は背景色です。座席表は「※遅番グレー」「※青PCなし」と、色そのものが
 * 意味を持つ表で、IMPORTRANGE は色を運びません。色の無い座席表は
 * 早番と遅番の区別が付かず、実物と違うものを見せることになります。
 *
 * その代わり、このファイルは原本に対して**読み取りしか行いません**。
 * 使っているのは getValues() と getBackgrounds() だけで、
 * セルに書き込む呼び出しは1つもありません。ここを変更するときは、
 * 書き込み系のメソッドを足さないこと。
 *
 * 【このファイルに書いてはいけないもの】
 *   - 座席表のファイルID（スクリプトプロパティ SEAT_FILE_ID に置く）
 *   - 社員の氏名
 *   このファイルは公開リポジトリに入ります。
 * ============================================================================
 */

// 取り込む範囲の上限。事故で巨大なシートを掴んだときに、
// Firestore へ大量に書き込むのを防ぐための歯止め。
//
// 実物は 21行 × 19列（2026年8月時点）。歯止めとしての意味は残しつつ、
// 席が増えても当たらない位置まで離してある。ここに当たると座席表の
// 端が黙って欠けるので、当たったことが分かるようログにも残す
// （欠けても画面はエラーを出さない＝気づけないため）。
var SEAT_MAX_ROWS = 60;
var SEAT_MAX_COLS = 40;

// 「色なし」とみなす背景色。Google スプレッドシートの既定の白。
// そのまま持たせると、ほぼ全セルに色が付いた状態になって無駄が大きい。
var SEAT_PLAIN_BG = ["#ffffff", "#fff", "white", ""];


// ══════════════════════════════════════════════════════════════════════
//  エントリポイント
// ══════════════════════════════════════════════════════════════════════

/**
 * 夜のトリガー（23時台）から呼ばれる。**翌日分**を先取りする。
 * 翌朝の出社前に、自分の席が分かっている状態を作るのが狙い。
 */
function syncSeatsTonight() {
  runSeatSync_(seatDateOf_(1), "night");
}

/**
 * 朝のトリガー（8時台）から呼ばれる。**当日分**を取り直す。
 *
 * 前夜に取り込んだものと中身を突き合わせ、変わっていれば記録する。
 * 座席は夜のうちに差し替わることがあり、前夜の版のまま出し続けると
 * 「アプリに書いてある席に座ったら違った」が起きるため。
 */
function syncSeatsMorning() {
  runSeatSync_(seatDateOf_(0), "morning");
}

/** 手動実行用。当日分を取り直す */
function manualSeatSync() {
  runSeatSync_(seatDateOf_(0), "manual");
}

/** 手動実行用。翌日分を取り込む */
function manualSeatSyncTomorrow() {
  runSeatSync_(seatDateOf_(1), "manual");
}


// ══════════════════════════════════════════════════════════════════════
//  本体
// ══════════════════════════════════════════════════════════════════════

function runSeatSync_(date, trigger) {
  var startedAt = new Date();
  var ymd = Utilities.formatDate(date, TZ, "yyyy-MM-dd");
  var note = "";

  try {
    var token = getAccessToken_();
    var projectId = requiredProp_("FIREBASE_PROJECT_ID");

    var ss = SpreadsheetApp.openById(requiredProp_("SEAT_FILE_ID"));
    var sheet = findSeatSheet_(ss, date);

    if (!sheet) {
      // 見つからないのは異常ではない。翌日分のタブがまだ作られていない、
      // 休業日でそもそも無い、という日が普通にある。
      // 既にある分を消さずに、探した記録だけ残す。
      note = "「" + seatLabelOf_(date) + "」のタブが見つかりませんでした";
      seatLog_("skip", trigger, ymd, new Date() - startedAt, note);
      return;
    }

    var grid = readSeatGrid_(sheet);
    if (!grid.rows.length) {
      note = "「" + sheet.getName() + "」は空でした";
      seatLog_("skip", trigger, ymd, new Date() - startedAt, note);
      return;
    }

    var fingerprint = seatFingerprint_(grid);
    var prev = readSeatDoc_(projectId, token, ymd);
    var changed = !!(prev && prev.fingerprint && prev.fingerprint !== fingerprint);

    var payload = {
      date: ymd,
      label: sheet.getName(),
      cols: grid.cols,
      rows: grid.rows,
      fingerprint: fingerprint,
      syncedAt: new Date(),
      syncedBy: trigger
    };

    // 朝の確認で中身が変わっていたことは、画面にも出す。
    // 「前の版を見ていたかもしれない」と気づける状態にしておくため。
    if (trigger === "morning") {
      payload.checkedAt = new Date();
      payload.changedAtCheck = changed;
    } else {
      // 夜の取り込みは新しい版なので、前回の確認結果は持ち越さない
      payload.checkedAt = null;
      payload.changedAtCheck = false;
    }

    writeDoc_(projectId, token, "seats/" + ymd, payload);

    note = changed
      ? "前回と内容が変わっていたため更新しました"
      : (prev ? "内容に変更はありませんでした" : "新規に取り込みました");
    note += "（" + grid.rows.length + "行 × " + grid.cols + "列）";
    // 上限に当たっていたら結果を warn にする。ok のまま流すと、
    // 端が欠けたまま何日も気づかれない。
    if (grid.truncated) {
      seatLog_("warn", trigger, ymd, new Date() - startedAt, note + " ※" + grid.truncated);
    } else {
      seatLog_("ok", trigger, ymd, new Date() - startedAt, note);
    }

    // 朝の確認で変わっていたときだけ知らせる。毎回流すと読まれなくなる。
    if (trigger === "morning" && changed) notifySeatChanged_(ymd, sheet.getName());

  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    seatLog_("error", trigger, ymd, new Date() - startedAt, msg);
    throw e;
  }
}

/**
 * その日の座席表のタブを探す。
 *
 * タブ名は「8/12 座席」「8/16座席」のように、スペースの有無が揃っていない。
 * 名前の完全一致で探すと、その日だけ取り込めないという分かりにくい
 * 落ち方をするので、名前から月日を拾って数値で突き合わせる。
 * ゼロ埋め（08/06）でも通る。
 */
function findSeatSheet_(ss, date) {
  var m = date.getMonth() + 1, d = date.getDate();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (name.indexOf("座席") < 0) continue;
    var mm = name.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (!mm) continue;
    if (Number(mm[1]) === m && Number(mm[2]) === d) return sheets[i];
  }
  return null;
}

/** ログや通知に出す、その日の呼び名（「8/16 座席」） */
function seatLabelOf_(date) {
  return Utilities.formatDate(date, TZ, "M/d") + " 座席";
}

/** 今日から offset 日ずらした日付（時刻は 0:00 に落とす） */
function seatDateOf_(offset) {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

/**
 * シートを「文字＋背景色」の格子として読む。
 *
 * 位置がそのまま席の配置なので、空セルも詰めずに残す（詰めると並びが崩れる）。
 * 右と下の完全に空いている部分だけを落として、表の大きさを実データに合わせる。
 */
function readSeatGrid_(sheet) {
  var range = sheet.getDataRange();
  var values = range.getValues();
  var bgs = range.getBackgrounds();

  // 上限に当たったかどうかは呼び出し側へ返す。座席表の端が欠けても
  // 画面はエラーを出さないので、記録に残らないと誰も気づけない。
  //
  // 判定はフラグで持つ。列の判定は行ごとに回るため、その場で文言を
  // 繋いでいくと同じ一文が行数ぶん並ぶ。
  var overRows = values.length > SEAT_MAX_ROWS;
  var overCols = false;

  var rowCount = Math.min(values.length, SEAT_MAX_ROWS);
  var colCount = 0;
  for (var r = 0; r < rowCount; r++) {
    if (values[r].length > SEAT_MAX_COLS) overCols = true;
    colCount = Math.max(colCount, Math.min(values[r].length, SEAT_MAX_COLS));
  }

  var parts = [];
  if (overRows) parts.push("行が上限（" + SEAT_MAX_ROWS + "）を超えました");
  if (overCols) parts.push("列が上限（" + SEAT_MAX_COLS + "）を超えました");
  var truncated = parts.length ? parts.join(" / ") + "。端を切り詰めています" : "";

  // 中身のある一番右の列 / 一番下の行を探す
  var lastCol = -1, lastRow = -1;
  for (var r2 = 0; r2 < rowCount; r2++) {
    for (var c2 = 0; c2 < colCount; c2++) {
      if (String(values[r2][c2] || "").trim() !== "") {
        if (c2 > lastCol) lastCol = c2;
        if (r2 > lastRow) lastRow = r2;
      }
    }
  }
  if (lastRow < 0) return { rows: [], cols: 0, truncated: truncated };

  var rows = [];
  for (var r3 = 0; r3 <= lastRow; r3++) {
    var cells = [];
    for (var c3 = 0; c3 <= lastCol; c3++) {
      var text = String(values[r3][c3] == null ? "" : values[r3][c3]).trim();
      var bg = normalizeSeatBg_(bgs[r3] ? bgs[r3][c3] : "");
      // 文字も色も無いセルは、空きとして最小の形で持つ
      var cell = { t: text };
      if (bg) cell.b = bg;
      cells.push(cell);
    }
    rows.push({ cells: cells });
  }
  return { rows: rows, cols: lastCol + 1, truncated: truncated };
}

/** 既定の白は「色なし」として捨てる。小文字に揃える */
function normalizeSeatBg_(bg) {
  var v = String(bg || "").trim().toLowerCase();
  if (SEAT_PLAIN_BG.indexOf(v) >= 0) return "";
  return v;
}

/**
 * 中身が変わったかを見るための指紋。
 * 文字と色の両方を含める。色だけが変わる（早番→遅番）ことがあるため。
 */
function seatFingerprint_(grid) {
  var flat = grid.rows.map(function (row) {
    return row.cells.map(function (c) { return c.t + "|" + (c.b || ""); }).join(",");
  }).join(";");
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, flat, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join("");
}

/** 既存の座席ドキュメントを読む。無ければ null */
function readSeatDoc_(projectId, token, ymd) {
  var res = UrlFetchApp.fetch(fsBase_(projectId) + "seats/" + ymd, {
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) return null;
  var f = (JSON.parse(res.getContentText()).fields) || {};
  return {
    fingerprint: f.fingerprint && f.fingerprint.stringValue,
    label: f.label && f.label.stringValue
  };
}

/**
 * 朝の確認で座席が変わっていたことを Chat に流す。
 * notify.gs が同じプロジェクトにあるときだけ動く（無くてもエラーにしない）。
 */
function notifySeatChanged_(ymd, label) {
  try {
    var webhook = PropertiesService.getScriptProperties().getProperty("CHAT_WEBHOOK_URL");
    if (!webhook || typeof postToChat_ !== "function") return;
    postToChat_(webhook,
      "*座席が変わりました*\n" +
      "「" + label + "」が前夜の取り込みから更新されています。出社前にご確認ください。\n" +
      "<" + APP_URL + "|第二CC Hub を開く>");
  } catch (e) {
    Logger.log("座席変更の通知に失敗: " + e);
  }
}


// ══════════════════════════════════════════════════════════════════════
//  ログとセットアップ
// ══════════════════════════════════════════════════════════════════════

function seatLog_(result, trigger, ymd, durationMs, note) {
  Logger.log("[座席] " + result + " / " + trigger + " / " + ymd + " / " + note);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("_seat_log");
    if (!sheet) {
      sheet = ss.insertSheet("_seat_log");
      sheet.appendRow(["実行時刻", "結果", "きっかけ", "対象日", "所要(ms)", "内容"]);
    }
    sheet.appendRow([
      Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss"),
      result, trigger, ymd, durationMs, note || ""
    ]);
    var extra = sheet.getLastRow() - 501;
    if (extra > 0) sheet.deleteRows(2, extra);
  } catch (e) {
    Logger.log("座席ログの書き込みに失敗: " + e);
  }
}

/**
 * トリガーを作り直す。1度だけ実行すればよい。
 *
 * 23時台に翌日分、8時台に当日分。時刻を「◯時台」でしか指定できないため、
 * 実際に走る時刻は 23:00〜23:59 / 8:00〜8:59 のどこかになる。
 */
function installSeatTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === "syncSeatsTonight" || f === "syncSeatsMorning") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncSeatsTonight").timeBased().atHour(23).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger("syncSeatsMorning").timeBased().atHour(8).everyDays(1).inTimezone(TZ).create();
  Logger.log("座席のトリガーを設定しました（23時台: 翌日分 / 8時台: 当日分の確認）");
}

/**
 * このスクリプトがどのアカウントとして動くかを出す。
 *
 * 座席表の共有先を間違えないために使う。エディタを開いているアカウントと
 * 実際に動くアカウントは、必ずしも同じとは限らない（トリガーを仕掛けた人の
 * 権限で動くため）。共有を依頼するときは、ここで出たアドレスを伝えること。
 */
function whoRunsThis() {
  var effective = Session.getEffectiveUser().getEmail();
  var active = "";
  try { active = Session.getActiveUser().getEmail(); } catch (e) {}

  var out = [
    "このスクリプトが動くアカウント: " + (effective || "(取得できませんでした)"),
    "いま操作しているアカウント　　: " + (active || "(取得できませんでした)"),
    "",
    "→ 座席表は「このスクリプトが動くアカウント」に共有してください（権限は閲覧者）。"
  ];

  // トリガーを仕掛けた人がいれば、実際に動くのはその人の権限。
  var trigs = ScriptApp.getProjectTriggers();
  out.push("設定済みのトリガー: " + trigs.length + "件");
  trigs.forEach(function (t) {
    out.push("  ・" + t.getHandlerFunction());
  });

  Logger.log(out.join("\n"));
  return out.join("\n");
}

/** 設定確認。セットアップ直後に実行する */
function checkSeatSetup() {
  var out = [];
  var props = PropertiesService.getScriptProperties();

  out.push((props.getProperty("SEAT_FILE_ID") ? "OK   " : "未設定") + "  スクリプトプロパティ SEAT_FILE_ID");
  out.push((props.getProperty("FIREBASE_PROJECT_ID") ? "OK   " : "未設定") + "  スクリプトプロパティ FIREBASE_PROJECT_ID");

  try {
    var ss = SpreadsheetApp.openById(requiredProp_("SEAT_FILE_ID"));
    out.push("OK     座席表を開けました: " + ss.getName());

    [0, 1].forEach(function (off) {
      var d = seatDateOf_(off);
      var sheet = findSeatSheet_(ss, d);
      var when = off === 0 ? "当日" : "翌日";
      if (!sheet) {
        out.push("--     " + when + "（" + seatLabelOf_(d) + "）のタブはまだありません");
        return;
      }
      var grid = readSeatGrid_(sheet);
      var colored = 0;
      grid.rows.forEach(function (r) {
        r.cells.forEach(function (c) { if (c.b) colored++; });
      });
      out.push((grid.truncated ? "警告   " : "OK     ") +
        when + "「" + sheet.getName() + "」 " +
        grid.rows.length + "行 × " + grid.cols + "列 ／ 色付きセル " + colored + "個" +
        (grid.truncated ? "  ※" + grid.truncated : ""));
    });
  } catch (e) {
    out.push("失敗   座席表を開けませんでした: " + e.message);
    out.push("       → 座席表の原本が、このスクリプトを動かすアカウントに共有されているか確認してください");
  }

  var trigs = ScriptApp.getProjectTriggers().filter(function (t) {
    var f = t.getHandlerFunction();
    return f === "syncSeatsTonight" || f === "syncSeatsMorning";
  });
  out.push((trigs.length === 2 ? "OK   " : "未設定") + "  トリガー（installSeatTriggers を実行してください）");

  Logger.log(out.join("\n"));
  return out.join("\n");
}
