# Instead-of-king slideshow

Silent 4-slide TikTok rec. Name the category king in the hook, show **two** peer products, put **your product last** at the best price. Always four images — never a fifth. Pick the two peers from `peers.json` (taggable brands with handles, prices, and reference stills). Original sound, no voiceover. Type does the selling.

This folder is the template. Each template in `contentTemplates/` is a directory that holds the how-to, the **source** slideshow or video that the pattern came from, and **refs** used to generate new stills.

Worked post: [generatedPosts/2026-09-09/post_001](../../generatedPosts/2026-09-09/post_001)

## Folder

```
instead-of-king-slideshow/
  README.md                 this file
  caption.txt               worked Pixl Nub caption (title + body)
  music.txt                 source slideshow sound URL
  peers.json                taggable peer roster (handles, features, prices)
  source/                   original TikTok slideshow (do not post these)
    slide-1.jpg … slide-4.jpg
    cover.jpg
    source.json
  refs/
    persona.jpg             narrator FACE for slide 1 only
    slide-4.jpg             real last-slide photo (product in situ)
    product.jpg             same file as slide-4.jpg in this worked example
    peers/                  product stills for optional peer slides
      femometer.jpg nowatch.jpg bebedi.jpg clair.jpg ringconn.jpg ultrahuman.jpg
```

Source: [@fashion.technically](https://www.tiktok.com/@fashion.technically/video/7665104701272132878) — 605k plays from ~223 followers. Lumysi is slide 4 of someone else’s rec. Full beat analysis: [generatedPosts/2026-09-09/post_001/analysis.md](../../generatedPosts/2026-09-09/post_001/analysis.md).

## Why it works

- The hook steals **search demand** from a brand everyone already knows (Oura, not you).
- Two real peers make it look like a category rec, not an ad.
- Last slide + Kickstarter / best price is the winner slot.
- Caption tags every handle so competitor fans get notified.
- Hashtags are category terms, not your brand name.
- Slide 1 is the **persona from `refs/persona.jpg`**, wearing the source hook’s clothes in the source hook’s room. Identity comes from the persona photo, not from `source/slide-1.jpg`.

Do not copy competitor footage, logos, or captions. Remix the structure. Generate original stills for slides 1–3. Slide 4 is a real product photo plus type.

## Slide anatomy

All frames are 1080×1920. Cream/gold type (`#F3E2A0`) on lifestyle photos. Brand name sits in a rounded taupe pill.

| # | Photo | Overlay | Job |
|---|---|---|---|
| 1 | **The woman in `refs/persona.jpg`**, wearing `source/slide-1.jpg` clothes in that room | `{Category} I'd use instead of {King}` then `(as a {credible identity} who {does the thing} for a living)` | Stop the scroll with the king’s name |
| 2 | Peer 1 product in use, **no logos in the photo** | Pill `{Peer 1}` / one-liner / **price** / dismissive footnote | Establish the category |
| 3 | Peer 2 product in use, no logos | Same stack as slide 2 | Second peer, still not you |
| 4 | **The real photo in `refs/slide-4.jpg`**. Do not generate a person holding the product. Overlay type only. | Pill `{You}` / promise / what it tracks / **price + platform** / the line only you can say | Winner slot |

### Overlay copy rules

- Hook: `{Category} I'd use instead of {King}`. For Pixl Nub the category is **Wellness trackers**, not health trackers. Keep the king’s exact consumer name (`Oura Ring`, not “a smart ring”).
- Peer one-liners: what it actually does, then the gap it leaves for you.
- Peer footnote: pigeonhole them (`great if you live in the gym`, `still a wearable`).
- Your footnote: the contrast (`no wearable. no camera. no subscription.`).
- Price on every product slide, same spot, larger than the one-liner.
- No VO. Extra argument goes in the caption.

### Caption formula

Mirror the source opener, then one extra argument block. Worked caption is in `caption.txt` in this folder (copied to `generatedPosts/2026-09-09/post_001/caption.txt` when posting).

```
What do you guys think? Which is your fav?
Follow for more {niche} recs!
What type of {niche} should I dive into next? Let me know :)

1. @{peer1}
2. @{peer2}
3. @{you}

{Hook restated in one line.}
{King does X. Peer 1 does Y. Peer 2 does Z.}
{None of them do the thing you do.}

{Your product in one breath + price + when/where to buy}

#{sourceHashtags that still fit} #{king} #{kickstarter}
```

Under 2,200 characters. Tag real TikTok handles. Keep the source hashtags that still apply (`#fashiontech #wearabletech #healthtracker #futureoffashion`); add the king and Kickstarter.

## How to make another one

### 1. Pick the cast

| Role | Pick | Rule |
|---|---|---|
| King | | Highest-search incumbent. |
| Peer 1 | one row in `peers.json` | Same category, easy to pigeonhole. Must have a real TikTok handle. |
| Peer 2 | a different row in `peers.json` | Closer to you than the king, still missing your wedge. |
| You | | Last slide. Best price or Kickstarter. |

The slideshow is always **four** stills (hook + two peers + you). Swapping peers does not add slides. Caption tags those two handles plus `@{you}`.

### Taggable peer roster (2026-09-09)

Apify TikTok + Google + website crawl. Use any two as slides 2–3. Generate lookalikes from `refs/peers/*.jpg` — do not post the reference photos or their logos.

| Brand | Handle | Form | Tracks | Price | Ref |
|---|---|---|---|---|---|
| WHOOP | `@whoop` | wrist band | strain, sleep, recovery | $239/year | worked example |
| Lumysi | `@lumysi_bracelet` | bracelet | sleep, steps, activity | $179 Kickstarter | worked example |
| Lumia Health | `@wearlumia` | ear cuff | sleep, cycle, ear blood flow | $249 | source slide 2 |
| Incora Health | `@incorahealth` | earrings | cycle, sleep, recovery, stress | $250 | source slide 3 |
| Femometer | `@femometer` | ring | cycle, ovulation, sleep, HRV | $160 Ring Air | `refs/peers/femometer.jpg` |
| NOWATCH | `@thenowatch` | jewelry watch | stress, sleep, activity | from $449, no sub | `refs/peers/nowatch.jpg` |
| Bèbèdí | `@wearbebedi` | waist beads | temperature, cycle, sleep | waitlist | `refs/peers/bebedi.jpg` |
| Clair | `@clair_health` | wristband | estrogen, progesterone, LH, FSH | $369, ships Dec 2026 | `refs/peers/clair.jpg` |
| RingConn | `@ringconn_official` | ring | sleep, HR, SpO2, recovery | $349 Gen 3, no sub | `refs/peers/ringconn.jpg` |
| Ultrahuman | `@ultrahumanhq` | ring | sleep, recovery, metabolism | $349 Ring AIR, no sub | `refs/peers/ultrahuman.jpg` |

Example recast (still four slides): hook stays Oura → Femometer $160 → NOWATCH from $449 → Pixl Nub $200 Kickstarter. Caption tags `@femometer` `@thenowatch` `@pixl.robotics`.

| Locked asset | File | Rule |
|---|---|---|
| Source slide 1 | `source/slide-1.jpg` | Pose, clothing, and background are locked. Do not restage. |
| Persona | `refs/persona.jpg` | **Who** she is. Face, skin, hair. Must be recognizable as this person. |
| Slide 4 photo | `refs/slide-4.jpg` | Real product-in-use still. Not a generated “holding” shot. |
| Credibility kicker | | Identity that makes the rec feel earned. |

The king is traffic. Peers are cover. You are the close. Do not put yourself on slide 2.

### 2. Write the four overlays and the caption

Keep body type to three lines max per slide.

### 3. Generate photos (Fal)

Use `FAL_API_KEY` from `.env` as `FAL_KEY`.

**Slide 1** — identity lock. [`fal-ai/nano-banana-pro/edit`](https://fal.ai/models/fal-ai/nano-banana-pro/edit), `aspect_ratio: 9:16`, `image_urls: [persona.jpg]` **only**. Do not pass `source/slide-1.jpg` in the same call — the source face will win.

If the face still drifts, run a **second** edit on that result: `image_urls: [dressed-still, persona.jpg]` with “keep clothes and room; make face and two thin face-framing braids match image 2.”

```
Keep this EXACT woman: same face, fair light skin, same long dark wavy hair
with two thin face-framing braids from the hairline, same eyes, slight wink
or closed-mouth smile. Do not change her identity.
Change only clothes and location. She now wears a purple graphic t-shirt,
a leopard-print faux fur coat draped over her shoulders like a cape, a white
floral lace headscarf, and a dark cord necklace with a blue heart pendant.
Vertical 9:16 mirror selfie, phone in her right hand at chest height.
Room: large arched mirror, beige-grey chevron herringbone stone above the
arch, modern tiled interior in the reflection. No extra people, no text.
```

**Slides 2–3** — no face needed. [`fal-ai/flux-pro/v1.1-ultra`](https://fal.ai/models/fal-ai/flux-pro/v1.1-ultra), `aspect_ratio: 9:16`, `raw: true`. Generic lookalikes of the peer form factor from `refs/peers/*.jpg` (or the source stills for Lumia / Incora). Never render their logo. Never post the reference JPEG as a slide.

**Slide 4** — do not generate. Crop `refs/slide-4.jpg` to 1080×1920 and composite the overlay. The worked example is a desk still: off-white cross-legged Pixl Nub, a hand with red nails resting on its head, silver laptop, dark textured wall, warm lamp.

Queue: `POST https://queue.fal.run/{model}` with `Authorization: Key $FAL_KEY`. Poll `status_url`. Do not ask the model to draw overlay type.

### 4. Composite type

Resize to 1080×1920, SVG overlay (Helvetica Neue / Arial):

- Hook title ~58px bold cream, kicker ~32px.
- Pill: `rgba(196,168,110,0.72)`, white 44px brand name, ~88px tall, centered near y=160–220.
- One-liner ~32–36px cream.
- Price ~48–56px cream.
- Footnote ~30px white near the bottom.

The repo has `sharp` for this.

### 5. Save stills, then post as a draft

Write four 1080×1920 stills plus caption into `generatedPosts/{YYYY-MM-DD}/post_NNN/` (next unused number that day, three digits: `post_001`, `post_002`, …). Copy `caption.txt` and `music.txt` from this template folder:

```
slide-1.jpg … slide-4.jpg
caption.txt
```

Music is always the source slideshow sound. The URL is in `music.txt` (same value as `source/source.json` → `music.musicUrl`):

```
https://www.tiktok.com/music/som-original-7649903858499734279
```

(`elvz` / **som original**, id `7649903858499734279`.) Do not leave music blank and do not pick a different track. Paste `caption.txt` as the caption. The first line becomes the TikTok title; the rest is the description.

Farm must be running (`npm start`). Device for `@pixl.robotics` is **Nu Work**, UDID `00008020-000819CA2203002E`. Destination is **draft**, never publish, until someone reviews it on the phone.

From the post folder:

```bash
curl -sS -X POST "http://127.0.0.1:3000/api/devices/00008020-000819CA2203002E/posts" \
  -H "Origin: http://127.0.0.1:3000" \
  -F "destination=draft" \
  -F "account=@pixl.robotics" \
  -F "musicUrl=$(cat music.txt)" \
  -F 'timing={"kind":"now"}' \
  --form-string "caption=$(cat caption.txt)" \
  -F "media=@slide-1.jpg;type=image/jpeg" \
  -F "media=@slide-2.jpg;type=image/jpeg" \
  -F "media=@slide-3.jpg;type=image/jpeg" \
  -F "media=@slide-4.jpg;type=image/jpeg"
```

Writes need `Origin: http://127.0.0.1:3000` (or `Authorization: Bearer …`). Without either, the farm returns 403.

Expect `202` and a schedule id. Poll until the execution finishes:

```bash
curl -sS "http://127.0.0.1:3000/api/devices/00008020-000819CA2203002E/posts/current"
```

Or use the device page: four slideshow images, Draft, that music URL, caption pasted from `caption.txt`. The farm accepts **1–4** images.

TikTok photo mode uses original sound via the music deep link (`Use this sound`), then the four stills in order.

## Worked mapping (Pixl Nub, 2026-09-09)

| Role | Fill |
|---|---|
| Category | Wellness trackers (not “health trackers”) |
| King | Oura Ring |
| Peer 1 | WHOOP — $239/year, gym |
| Peer 2 | Lumysi — $179 Kickstarter, still a wearable |
| You | Pixl Nub — $200 Kickstarter, desk robot |
| Slide 1 layout | `source/slide-1.jpg` — mirror selfie, leopard coat, chevron wall |
| Persona face | `refs/persona.jpg` — young woman, face-framing braids |
| Slide 4 | `refs/slide-4.jpg` — Nub on the desk, hand on its head |
| Kicker | woman who sits at a desk for a living |
| Gap only you cover | The workday. Wearables see sleep and strain, not the eight hours you sit. |
| Music | `source/source.json` → `music.musicUrl` |
| Account | `@pixl.robotics` on Nu Work |
| Destination | `draft` |

## Do not

- Swap the king for your own name in the hook.
- Attack the king. Borrow them.
- Restage slide 1 (new pose, clothes, or room).
- Put logos in the generated photos.
- Generate a video or VO for this template.
- Clone competitor product shots or caption text.
- Generate slide 4 as a person holding the product. Use the real photo.
- Skip `musicUrl` or pick a different track. This template always uses the source slideshow sound.
- Post publicly from the farm. Save a **draft** and review it on the phone.
