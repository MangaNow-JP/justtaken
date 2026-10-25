# JustTaken LPデザイン案 v2

生成方法: 内蔵 image_gen ツール。v1を編集対象にし、ユーザーの参考画像から読み取った構成を文章で指定した。参考画像の直接入力はツールに拒否されたため使用していない。

## 今回の方向性

- ブランドの中心は「ありのままを撮って、ありのままでつながるSNS」。カメラ・動画撮影とSNSを最初に伝える。
- AI生成や過度な加工が身近な時代に、自分が撮影した日常をそのまま残し、共有する価値を見せる。
- 白地、大きく太いゴシックの中央見出し、浮遊する写真タイル、横並びの写真・動画カード、淡色パネル、大きいフッターロゴ。配色は深緑とライムを継続。
- 撮影証明・第三者時刻・監査ログは、撮った記録とファイルの一致を確認するための裏付けとして扱う。被写体の真実性や改ざん不可能性を保証する表現は使わない。
- 写真・人物・アプリ画面はAI生成のデザイン用仮素材。本番LPでは実際に撮影した写真・動画に差し替え、仮画像を検証済み原本として掲載しない。
- ネイティブカメラのHDR・露出等の通常処理まで排除する仕様変更は今回行っていない。写真・動画の原画保持方針を継続する。
- 現時点はLPのUI案。Web実装・本番公開は行っていない。

## 生成プロンプト

Use case: ui-mockup / redesign of an existing landing-page concept.
Input image 1: the previous JustTaken landing-page design, EDIT TARGET. Preserve the JustTaken identity, camera-corner JT monogram, forest green and lime brand colors. Redesign its layout and message substantially.
Style reference, expressed as a design brief: airy white canvas, a centered extremely bold sans-serif hero with floating candid photo tiles around its edges, horizontal photo card carousels, soft pastel rounded feature panels, compact rounded buttons, and an oversized wordmark on a near-black footer. No huge empty loading gaps. This style replaces the old formal serif layout.

Produce ONE beautiful, complete high-fidelity Japanese landing-page UI concept for JustTaken. Tall portrait full webpage, approximately 1600x3000, edge-to-edge, straight-on, no browser chrome or presentation board. This is a prelaunch design mockup, not evidence of actual photography.

CORE POSITIONING:
JustTaken is a camera app AND a social network for sharing the ordinary, real photos and videos people actually capture, in an era of AI-generated and heavily edited imagery. The emotional center is candid human life, authentic self-expression, and connecting through the moments you really saw. Capture provenance is a quiet supporting feature, NOT a cybersecurity product or the main hero. Make this feel inviting, youthful, warm and social, not formal, institutional or forensic.

ART DIRECTION:
White #FFFFFF dominates, almost-black/deep forest #103D34 type, fresh lime #C6F56D accents. Delicate pastel mint, butter yellow and pale blue panels. Very faint mint/warm sunlight glow behind the hero. Modern bold Japanese GOTHIC SANS-SERIF typography throughout, like Noto Sans JP / a contemporary geometric Japanese grotesk. NO serif or Mincho headlines. Rounded buttons, precise grids, generous margins, organic floating photos at the hero edge, playful but not cluttered. Large photography and concise editorial copy.
Photo subjects are everyday candid adult friends, an unposed front-camera selfie with natural skin texture and a few flyaway hairs, a pet dog, a shared meal, walking through town, a breezy seaside scene. Normal clothes, genuine-looking varied expressions and light, imperfect framing, believable motion in video stills. NOT glamorous beauty ads, studio models, makeup transformations, airbrushed faces or AI effects. Photography here is illustrative mockup material, with a small clear footer note stating that.

PAGE CONTENT AND COMPOSITION:
1. Clean compact top navigation: small JT camera-corner monogram and JustTaken wordmark at left. Links 「JustTakenとは」「撮る」「つながる」「撮影証明」. Right a small lime pill 「先行登録」.
2. A AIRY PHOTO-COLLAGE CENTERED HERO, not the old left-copy/right-two-phones layout.
Small eyebrow: 「撮って、つながる。写真と動画のSNS」
Huge heavy sans-serif heading, exactly:
「盛らない、つくらない。
いまを、そのまま。」
First line near-black, second line forest green with a restrained lime underline/highlight.
Supporting copy, exactly:
「AIでつくれる時代に、あなたが撮った「いま」を。
ありのままの写真と動画で、つながろう。」
Centered forest-green rounded CTA 「先行登録する →」 and secondary quiet link 「JustTakenを知る」.
Tiny note 「iOS・Android向けに開発中」.
Arrange five lightly rotated rounded photo tiles OUTSIDE the headline area, framing the composition: an adult friends' candid selfie, dog in grass, a sunlit meal, beach video still with a small play icon, a street-walk snapshot. Mostly image-only, minimal chrome. Headline remains completely unobstructed. No giant phone in this hero.
3. A wide social gallery section with left-aligned bold heading 「今日、なにを撮った？」 and a tiny right link 「ありのままの日常へ →」.
Six portrait photo/video cards in a single horizontal row with rounded corners, casual varied scenes. Small avatar and short captions beneath, such as 「帰り道の空」「いつもの朝」「友だちと」「今日のごはん」「ふとした瞬間」「海まで散歩」. One or two video play icons and durations under 60s. No invented numeric engagement stats or user count. Small subtle lime capture check on just two cards, not giant proof badges everywhere.
4. Centered editorial heading 「うまく撮れなくても、残したい瞬間がある。」
One broad soft BUTTER-YELLOW rounded feature panel. Left heading 「ありのままの自分で、つながろう。」 with brief copy 「飾らない日常も、何気ない一瞬も。撮ったままの写真と動画が、会話のきっかけになる。」 and a small dark button 「JustTakenのSNS」.
Right a playful collage of candid photography around ONE thin, realistic smartphone showing the JustTaken white social feed with a photo, unobtrusive check label 「撮影記録を確認」, simple social icons and prominent lime camera navigation button. No location names, map pins, dates or coordinates. Do not use two large hero phones from the old design.
Below this panel, two understated wide accordion-like rows, first mint, second pale blue:
「写真も動画も、元の画質で。」 and 「SNSに投稿せず、撮影証明を共有。」, each with a small down arrow.
5. A clean white camera-focused section: heading 「あなたの目線を、そのまま。」 and short supporting line 「写真も、最大60秒の動画も。インカメラでも、アウトカメラでも。」.
Below, three beautiful large editorial crops: candid selfie, broad sunlit landscape, motion-filled everyday video still with a play button. Thin tabs above: 「写真」「動画」「インカメラ」. Minimal labels, no editing sliders, no filter picker, no before/after.
6. SMALL SUPPORTING TRUST SECTION on very pale sage, not a dominant dark security band. Heading 「撮った記録が、リアルを支える。」. Three tidy inline steps with line icons and generous spacing: 「アプリで撮影」 → 「原本と記録を保持」 → 「受け取った人が確かめる」.
Single sentence: 「撮影の記録と、写真・動画の一致をあとから確認できます。」. Quiet text link 「撮影証明の仕組み →」. No shields, locks, blockchain symbols, code, hashes, SQL, architectural diagrams or technical jargon.
7. Spacious centered closing CTA: 「そのままの「いま」を、ここに。」 and a lime pill 「先行登録する →」. Supporting note 「写真と動画で、ありのままにつながるSNS。」.
8. Deep near-black FOREST GREEN footer, small navigation and logo at top, then a gigantic beautiful near-white JustTaken wordmark stretching across the width, inspired by the reference footer. Correct footer copyright 「© 2026 JustTaken」.
Small scope note: 「撮影経路とファイルの一致を確認する仕組みです。被写体の真実性を保証するものではありません。」
Small mockup disclosure: 「写真・画面はデザイン用のイメージです。」

Important constraints: exact, legible Japanese, bold clean sans-serif, concise copy, large photos, responsive-feeling clean spacing, visually complete footer. Retain JustTaken identity while markedly changing v1 into the white, lively, photo-centric style of the style brief above. Never include BeautyPlus branding or AI creation/editing feature names. No stock customer logo wall, fabricated testimonials or adoption numbers, patent claims, App Store download badges or claims of general release. Do not promise 100% real imagery or impossibility of forgery. Do not imply the generated mockup's images are authenticated real photographs. No geographic labels or sample timestamps. Opaque background.

