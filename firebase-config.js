// ============================================================
// Firebase ウェブアプリ設定
// ------------------------------------------------------------
// ここに書かれている apiKey は「秘密鍵」ではありません。
// Firebase のウェブ向け設定値は、ブラウザに配信される時点で
// 必ず利用者から見える値であり、公開されることを前提に設計されています。
// プロジェクトを識別するためのIDに過ぎず、これだけでデータは読めません。
// データを守っているのは firestore.rules（セキュリティルール）です。
// 詳しくは README.md の「apiKey について」を参照してください。
//
// 【設定手順】
//   Firebase コンソール → プロジェクトの設定 → マイアプリ → ウェブアプリ
//   に表示される firebaseConfig をそのまま下に貼り付けてください。
// ============================================================

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCiwY4TtVD5eIrzjth_4ZXiIFy-_XaIv2s",
  authDomain: "daini-cc-hub.firebaseapp.com",
  projectId: "daini-cc-hub",
  storageBucket: "daini-cc-hub.firebasestorage.app",
  messagingSenderId: "14141955390",
  appId: "1:14141955390:web:248c07b1aa7bd49980e06f",
  // measurementId はGoogleアナリティクス用。このアプリでは使わないため含めない。
};

// Googleログイン画面で、会社ドメインのアカウントを優先表示させるヒント。
// 例: "example.co.jp"
// 空文字なら通常のアカウント選択画面になります。
// これは利便性のためのヒントであり、認証の制限ではありません。
// 実際の制限は Firestore のメンバーマスタ（許可リスト）で行っています。
export const SIGN_IN_HINT_DOMAIN = "";
