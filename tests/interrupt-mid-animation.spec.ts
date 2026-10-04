import { test, expect, type Page } from "@playwright/test";

// These tests guard the "stop-and-retarget" bug: interrupting a fragment's
// exit animation (gravity-exit's CSS-transition fall, bats-exit's manual
// rAF shape morph) by navigating the opposite direction must redirect the
// live animation immediately, not let it run to completion first and only
// pick up the reverse once its turn in the stagger schedule arrives. Every
// assertion here reads real DOM/computed-style state a short, fixed delay
// after the interrupt — never "wait until it eventually settles" — since
// that's exactly the test category whose absence let the original bug ship.

async function waitForReveal(page: Page) {
  await page.waitForFunction(() => (window as any).Reveal && (window as any).Reveal.isReady());
}

async function gotoSlide(page: Page, index: number) {
  await page.evaluate((i) => (window as any).Reveal.slide(i), index);
}

// Parses the `ty` (translateY) component out of a computed 2D CSS matrix.
function translateY(transform: string): number {
  if (!transform || transform === "none") return 0;
  const m = transform.match(/matrix\(([^)]+)\)/);
  if (!m) return 0;
  const parts = m[1].split(",").map(Number);
  return parts[5];
}

test.describe("gravity-exit: stop-and-retarget", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/index.html");
    await waitForReveal(page);
    // Slide 1 (0-indexed) is the plain sweep-order gravity-exit fragment.
    await gotoSlide(page, 1);
    // Same async <img> -> inlined <svg> race as the bats-exit suite below:
    // pressing the fragment key before inlineSvgImages finishes means
    // fragmentshown finds no <svg> yet and silently skips startFalling.
    await page.waitForFunction(() => document.querySelector(".fragment.gravity-exit svg[data-gravity-ready]"));
  });

  test("reverse interrupts an in-flight fall immediately", async ({ page }) => {
    await page.keyboard.press("ArrowRight"); // fragmentshown -> startFalling
    await page.waitForTimeout(200); // well inside the 850ms fall

    const before = await page.evaluate(() => {
      const svg = document.querySelector(".present .gravity-exit svg") as any;
      const marks: any[] = svg._gravityMarks;
      const idx = marks.findIndex((m) => m.state === "falling");
      if (idx === -1) return null;
      return { idx, transform: getComputedStyle(marks[idx].el).transform };
    });
    expect(before, "expected at least one mark to be mid-fall").not.toBeNull();

    await page.keyboard.press("ArrowLeft"); // fragmenthidden -> resetFalling
    await page.waitForTimeout(80); // short enough that a deferred-reverse bug wouldn't have reached this mark yet

    const after = await page.evaluate((idx) => {
      const svg = document.querySelector(".present .gravity-exit svg") as any;
      const m = svg._gravityMarks[idx];
      return { state: m.state, transform: getComputedStyle(m.el).transform };
    }, before!.idx);

    expect(after.state).toBe("returning");
    expect(translateY(after.transform)).toBeLessThan(translateY(before!.transform));
  });

  test("forward interrupts an in-flight return immediately (symmetric case)", async ({ page }) => {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(150); // give the fix's immediate-redirect time to actually kick in

    const before = await page.evaluate(() => {
      const svg = document.querySelector(".present .gravity-exit svg") as any;
      const marks: any[] = svg._gravityMarks;
      const idx = marks.findIndex((m) => m.state === "returning");
      if (idx === -1) return null;
      return { idx, transform: getComputedStyle(marks[idx].el).transform };
    });
    expect(before, "expected at least one mark to be mid-return").not.toBeNull();

    await page.keyboard.press("ArrowRight"); // interrupt the reverse
    await page.waitForTimeout(80);

    const after = await page.evaluate((idx) => {
      const svg = document.querySelector(".present .gravity-exit svg") as any;
      const m = svg._gravityMarks[idx];
      return { state: m.state, transform: getComputedStyle(m.el).transform };
    }, before!.idx);

    expect(after.state).toBe("falling");
    expect(translateY(after.transform)).toBeGreaterThan(translateY(before!.transform));
  });

  test("visual sanity check: mid-interrupt screenshot", async ({ page }) => {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(80);
    await page.screenshot({ path: "test-results/gravity-mid-interrupt.png" });
  });
});

test.describe("bats-exit: stop-and-retarget", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/index.html");
    await waitForReveal(page);
    // Slide 5 (0-indexed) is the random-order bats-exit fragment.
    await gotoSlide(page, 5);
    // The fragment's <img> is replaced with an inlined <svg> asynchronously
    // (inlineSvgImages); pressing the fragment key before that finishes
    // means fragmentshown finds no <svg> yet and silently skips startBats,
    // leaving every mark stuck "idle" for the rest of the test.
    await page.waitForFunction(() => document.querySelector(".fragment.bats-exit svg[data-bats-ready]"));
  });

  test("reverse interrupting a live morph continues the same proxy, not a fresh one", async ({ page }) => {
    await page.keyboard.press("ArrowRight"); // fragmentshown -> startBats
    // With ~300 marks and a random order, the forward stagger spread
    // (STAGGER_MS * mark count, up to ~3.7s here) is comparable to or
    // longer than MORPH_MS (2500ms) — picking "any morphing mark" risks
    // grabbing one that only just started and is still mid-crossfade-in.
    // _batsLastOrder[0] is deterministic: it always starts at delay 0 (so
    // it's reliably well into its morph by 2000ms) and sits at the *last*
    // stagger position on the reverse pass (n-1), making it the strongest
    // possible check that the reverse redirect is state-driven, not
    // index-driven.
    await page.waitForTimeout(2000);

    const before = await page.evaluate(() => {
      const svg = document.querySelector(".present .bats-exit svg") as any;
      const marks: any[] = svg._batsMarks;
      const m = svg._batsLastOrder[0];
      const idx = marks.indexOf(m);
      if (m.state !== "morphing" || !m.proxyEl) return null;
      const proxy = m.proxyEl;
      proxy.dataset.testMarker = "live-proxy";
      return { idx, opacity: getComputedStyle(proxy).opacity };
    });
    expect(before, "expected the earliest-starting mark to be mid-morph").not.toBeNull();
    expect(Number(before!.opacity)).toBeGreaterThan(0.9); // forward morph keeps the proxy fully opaque throughout

    await page.keyboard.press("ArrowLeft"); // fragmenthidden -> resetBats, should flip this mark to "unmorphing" at delay 0
    await page.waitForTimeout(150);

    const midReverse = await page.evaluate((idx) => {
      const svg = document.querySelector(".present .bats-exit svg") as any;
      const m = svg._batsMarks[idx];
      return {
        state: m.state,
        sameProxy: m.proxyEl && m.proxyEl.dataset.testMarker === "live-proxy",
      };
    }, before!.idx);
    expect(midReverse.state).toBe("unmorphing");
    expect(midReverse.sameProxy).toBe(true);

    // Now interrupt the reverse: forward must resume the SAME proxy from
    // its live, partially-unmorphed state. The regression this guards
    // against is morphOne() tearing the proxy down and rebuilding an
    // invisible one that fades in from scratch — which would show up here
    // as a brand-new element (no test marker) and a transient opacity dip.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(20); // early enough to catch a fade-in-from-0 dip if the bug regressed

    const afterInterrupt = await page.evaluate((idx) => {
      const svg = document.querySelector(".present .bats-exit svg") as any;
      const m = svg._batsMarks[idx];
      return {
        state: m.state,
        sameProxy: m.proxyEl && m.proxyEl.dataset.testMarker === "live-proxy",
        opacity: m.proxyEl ? getComputedStyle(m.proxyEl).opacity : null,
      };
    }, before!.idx);

    expect(afterInterrupt.state).toBe("morphing");
    expect(afterInterrupt.sameProxy).toBe(true);
    expect(Number(afterInterrupt.opacity)).toBeGreaterThan(0.9);
  });

  test("forward interrupting a live reverse-flight resumes flyAway, not a re-morph", async ({ page }) => {
    await page.keyboard.press("ArrowRight");
    // _batsLastOrder[0] starts (and finishes its MORPH_MS morph) earliest,
    // so by 2600ms it's reliably into "flying" — and, same as above, it
    // sits at the last reverse stagger position, the strongest check that
    // the redirect is state- not index-driven.
    await page.waitForTimeout(2600);

    const before = await page.evaluate(() => {
      const svg = document.querySelector(".present .bats-exit svg") as any;
      const marks: any[] = svg._batsMarks;
      const m = svg._batsLastOrder[0];
      const idx = marks.indexOf(m);
      if ((m.state !== "flying" && m.state !== "gone") || !m.proxyEl) return null;
      const proxy = m.proxyEl;
      proxy.dataset.testMarker = "live-proxy";
      return { idx, d: proxy.getAttribute("d") };
    });
    expect(before, "expected the earliest-starting mark to have taken flight").not.toBeNull();

    await page.keyboard.press("ArrowLeft"); // resetBats -> reverseFlyAway at delay 0 (reverse-order position 0)
    await page.waitForTimeout(100);

    const midReverse = await page.evaluate((idx) => {
      const svg = document.querySelector(".present .bats-exit svg") as any;
      const m = svg._batsMarks[idx];
      return { state: m.state, sameProxy: m.proxyEl?.dataset.testMarker === "live-proxy" };
    }, before!.idx);
    expect(midReverse.state).toBe("unflying");
    expect(midReverse.sameProxy).toBe(true);

    await page.keyboard.press("ArrowRight"); // interrupt back to forward flight
    await page.waitForTimeout(50);

    const afterInterrupt = await page.evaluate((idx) => {
      const svg = document.querySelector(".present .bats-exit svg") as any;
      const m = svg._batsMarks[idx];
      const proxy = m.proxyEl;
      return {
        state: m.state,
        sameProxy: proxy?.dataset.testMarker === "live-proxy",
        d: proxy ? proxy.getAttribute("d") : null,
      };
    }, before!.idx);

    // Resuming flight must not re-enter the shape morph: the outline stays
    // the fully-formed bat shape throughout (unchanged `d`), only the
    // position/scale/opacity transition redirects.
    expect(afterInterrupt.state).toBe("flying");
    expect(afterInterrupt.sameProxy).toBe(true);
    expect(afterInterrupt.d).toBe(before!.d);
  });

  test("visual sanity check: mid-interrupt screenshot", async ({ page }) => {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(2000);
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(150);
    await page.screenshot({ path: "test-results/bats-mid-interrupt.png" });
  });
});
