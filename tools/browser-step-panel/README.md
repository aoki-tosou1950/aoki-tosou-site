# 手順パネル（browser-step-panel）

AIがブラウザを操作している間、画面右下に次の内容を出すパネルです。

- 状態：「AIが操作しています」「あなたの入力を待っています」「完了しました」「止まりました」
- `3／4 GA4 を入れる` のような、作業名と全体の何手目か
- 手順の一覧（✓ 完了・▶ 実行中・・ 未着手）
- 人間への依頼（例：「チャットで教えてください」。入力待ちのときは目立つ色で出します）

公開サイト（aoki-tosou.net）の各ページからは読み込みません。ブラウザを操作する側だけが使います。

## 使い方

### Playwright

```js
const { attachStepPanel } = require('./tools/browser-step-panel/playwright-helper');

const panel = await attachStepPanel(context); // BrowserContext
await panel.show({ task: 'GA4 を入れる', steps: ['ログインする', 'プロパティを探す', 'プロパティを作る', '測定IDを控える'] });
await panel.next();                 // 次の手順へ（最後まで進むと「完了」）
await panel.ask('プロパティを作るアカウントを決めます。チャットで教えてください。');
await panel.update({ status: 'working', message: '' });
await panel.error('ログイン画面から進めません');
await panel.hide();
```

状態はNode側で持つため、ページを移ったときや新しいタブを開いたときも同じ表示に戻ります。

### Claude in Chrome など、ページ内でJSを実行できるツール

`step-panel.js` の中身をページで実行してから、`window.AokiStepPanel` を呼びます（API は上と同じで `show / update / next / ask / done / error / hide / getState`）。
この方法ではページを移ると表示が消えるので、移った先でもう一度実行し、`AokiStepPanel.restore(前回の getState() の結果)` で戻します。

## 設計で気をつけたこと

- **操作の邪魔をしない**：`pointer-events: none` にしているので、パネルの下にあるボタンもそのままクリックできます。
- **ページの見た目を壊さない／壊されない**：Shadow DOM の中に描画します。
- **厳しいCSPやTrusted Typesのページ（Googleの管理画面など）でも出る**：`innerHTML` は使っていません。後から読み込むときは、CSPの影響を受けない Playwright の評価経路を使います。
- **画面に合わせる**：ダークモードに対応し、スマホ幅では `画面幅 − 32px` に収まり、動きを減らす設定（prefers-reduced-motion）では点滅を止めます。読み上げ用に `role="status"` と `aria-live` を付けています。

## テスト

```sh
NODE_PATH=$(npm root -g) node --test tools/browser-step-panel/step-panel.test.js
```

右下の位置、手順と入力待ちの表示、パネルの下のボタンをクリックできるか、ページを移ったときや別タブでの復元、CSPが厳しいページ、スマホ幅でのはみ出しを確認します。Playwright がない環境ではスキップします。

## 既存手段の調査と判断（変更記録）

| 候補 | 判断 | 理由 |
| --- | --- | --- |
| repo 内の既存実装 | 該当なし | `AIが操作` `step-panel` `playwright` などで検索しましたが、似たものはありませんでした。 |
| Playwright 公式 API（`addInitScript` / `exposeBinding` / `evaluate`） | 採用 | ページを移っても表示を戻す仕組みと、どのページにも読み込む仕組みは、これらの公式機能だけで作っています。 |
| Driver.js / Shepherd.js / Intro.js（製品ツアー用OSS） | 参照・不採用 | 要素を強調しながら案内するためのもので、人が「次へ」を押すことが前提です。また外部のCSSやJSを読み込むので、CSPが厳しい管理画面では動かないことがあります。今回は「クリックを素通しする、状態を表示するだけのパネル」なので、依存を持たない約250行の小さなスクリプトで作りました。 |
| ブラウザ拡張（Chrome 拡張の content script） | 不採用（今回） | インストールと権限管理が別に必要になります。Playwright 以外のツールでも、`step-panel.js` をそのまま実行すれば同じ表示を出せます。 |

関連する過去の障害記録・判断記録（`docs/`）は確認しましたが、ブラウザ操作の表示に関するものはありませんでした。
