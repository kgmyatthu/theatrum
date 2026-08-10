import { useMemo } from 'react';
import { useAppState } from '@/state/AppContext';
import {
  MEN_PER_MONTH,
  REFERENCE_POP,
  menPerMonth,
  raiseBudget,
  standingArmyCeiling,
} from '@/utils/movement';
// The stat rows below the plots are the card's own rows — literally the
// same classes, imported rather than re-declared, so they can never drift
// out of step with the four rows above them.
import card from './ProvinceInfo.module.css';
import styles from './NationPower.module.css';

interface NationPowerProps {
  /** Owning nation of the hovered province. Already canonical lowercase —
   *  it comes straight off feature.properties.owner, which is the same key
   *  populationByNation and force.nation are written with. */
  nation: string;
}

// ── Plot geometry, in viewBox units ──────────────────────────────────
// The chart is authored at 280 units wide and pinned to 280 CSS px by
// .chart, so one unit is one CSS pixel and every size below can be read as
// px. EVERY constant in this block is part of that one scale: widening the
// CSS without widening the viewBox would leave the geometry at its old
// size and silently magnify every 8px label along with it.
const VB_W = 280;
// Tall enough for the plot AND the x-axis label band underneath it. A
// viewBox cropped to the plot is what makes a card grow a nested
// scrollbar, so the band is part of the drawing, not an afterthought.
const VB_H = 115;
// Left gutter: fits a "20,000" tick at 8px with air. 20,000 is the widest
// label the axis can now produce — it is the top tick both on the fixed
// 120M domain (yMax 20,000, step 5,000) and on china's widened one (yMax
// 26,956, step 10,000). It was "40,000" while MEN_PER_MONTH was 15000;
// the gutter did not have to move with it because the two labels are the
// same six characters, but the number quoted here has to stay the one a
// reader will actually see on the chart.
const PLOT_X0 = 48;
// Not flush to VB_W: an <svg> root clips at its viewBox by default, and the
// nation whose population IS the domain maximum (china, and only china)
// parks its marker on this exact line — the 7-unit ring needs to land
// inside the drawing or a quarter of the marker is cropped away.
const PLOT_X1 = 270;
const PLOT_Y0 = 12; // headroom, so a marker at the curve's top keeps its ring
const PLOT_Y1 = 95;
const PLOT_W = PLOT_X1 - PLOT_X0;
const PLOT_H = PLOT_Y1 - PLOT_Y0;
/** Baseline of the x-axis labels, below the plot floor. */
const AXIS_BASELINE = 108;
/** Samples along the curve, spaced by SAMPLE_WARP rather than evenly.
 *
 *  The curve is concave, so every straight chord sits BELOW the arc it
 *  spans, and all of that error piles up at the steep left end. Evenly
 *  spaced, 40 samples of the CUBE-root curve are off by 4.7 units — a
 *  visibly flattened knee — where the same 40 samples of the sqrt curve
 *  this replaced were off by 0.2 and evenness was free.
 *
 *  Warping x by the curve's own inverse spaces the samples evenly along Y
 *  instead, which is where the error actually lives: the same 40 points
 *  then come in under 0.15 units on both domains, better than the old
 *  curve ever managed. It is a DENSITY heuristic, not an assertion about
 *  the maths — every plotted y still comes from menPerMonth() — so if the
 *  exponent moves again the plot stays truthful and merely samples less
 *  evenly than it could. */
const SAMPLES = 40;
const SAMPLE_WARP = 3;
/** Fixed x-axis maximum. Holding the domain still across hovers is what
 *  makes two nations comparable at a glance — a domain that rescaled to
 *  each nation would draw sweden and britain the identical picture. 120M
 *  covers 77 of the 78 nations; china (293.8M) pushes past it and gets its
 *  own, honestly labelled, wider domain rather than being clipped. */
const X_DOMAIN_FLOOR = 120e6;

const METER_H = 10;

/** Smallest 1/2/5 x 10^n step that spans `max` in at most four intervals —
 *  gridlines land on numbers a reader recognises (10,000) instead of
 *  whatever an even division of the data produced (6,739, on china's
 *  26,956-man axis). */
function tickStep(max: number): number {
  for (let e = 0; e < 12; e += 1) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** e;
      if (max / step <= 4) return step;
    }
  }
  return max;
}

/** Millions, one decimal, trailing .0 dropped by Number itself: 120M and
 *  293.8M. Only ever used on the x-axis end label, where a fully written
 *  120,000,000 would be half the axis wide. */
function millions(v: number): string {
  return `${Math.round(v / 1e5) / 10}M`;
}

/** A bar with a square baseline end and a rounded data end — the mark spec
 *  for a meter, as one path because rx would round both ends. Under half a
 *  bar-height there is no room for the cap at all, so a sliver renders
 *  square rather than bulging into a lozenge wider than its own value. */
function barPath(w: number, h: number): string {
  const r = h / 2;
  if (w <= r) return `M0 0 H${w.toFixed(2)} V${h} H0 Z`;
  return `M0 0 H${(w - r).toFixed(2)} A${r} ${r} 0 0 1 ${(w - r).toFixed(2)} ${h} H0 Z`;
}

const n = (v: number): string => v.toLocaleString('en-US');

/**
 * Population-and-manpower readout for the nation owning the hovered
 * province. Three pieces, deliberately three and not one chart:
 *
 *  1. the cube-root curve of men-per-month against population, with this
 *     nation marked on it — the derivation, not just its answer, and the
 *     nation's total population named underneath it because that number is
 *     the marker's x coordinate;
 *  2. a meter of the standing army against the 3.5%-of-population ceiling;
 *  3. the raw numbers as stat rows.
 *
 * The ceiling is NOT plotted on the curve, and that separation is the whole
 * reason there are three pieces. The curve's y-axis is men per MONTH (a
 * flow); the ceiling is men under arms (a stock). Sharing one plot between
 * them means two y-scales, whose alignment would be arbitrary and would
 * invent a relationship the data does not contain. A ratio against a limit
 * is a meter; it gets one.
 *
 * The card is pointer-events:none — the hover IS the response, so there is
 * no nested tooltip to reach for. Every plotted value therefore also
 * appears as a labelled number, and nothing is gated behind an interaction
 * that cannot happen.
 */
export function NationPower({ nation }: NationPowerProps) {
  const { forces, populationByNation, lastTurnDays } = useAppState();

  // A SCALAR lookup, never a province scan: this runs on every mousemove
  // that crosses a border, and the 4,596-feature sum was already taken once
  // at the ADVANCE_TURN that anchored the table.
  //
  // The two-step resolve mirrors checkRaiseBudgets (and AddForcePanel) line
  // for line, because the point of this card is to show the figures that
  // gate will use: no table at all stays undefined and fails OPEN through
  // menPerMonth/standingArmyCeiling; a nation the table simply does not
  // list is 0, a real (if unflattering) population. The tempting
  // `populationByNation?.[nation]` collapses the two.
  const pop =
    populationByNation === undefined ? undefined : (populationByNation[nation] ?? 0);

  // Cheap (~30 forces) but keyed anyway, because the alternative is
  // re-summing on every unrelated re-render of the hover card.
  //
  // `!== 'navy'`, not `=== 'army'`, and that is the gate's own predicate
  // rather than a stylistic choice: checkRaiseBudgets buckets an unknown
  // branch as army, so a force with a bad branch counts against the ceiling
  // there. Matching it here is what stops the meter reading comfortable
  // while the server refuses the recruit.
  const standing = useMemo(
    () =>
      forces.reduce(
        (sum, f) => (f.nation === nation && f.branch !== 'navy' ? sum + f.strength : sum),
        0,
      ),
    [forces, nation],
  );

  // Whole-turn cap, not the monthly rate: raiseBudget multiplies by the
  // turn's whole months, so a 60-day turn buys two months of recruits and a
  // 29-day turn buys none. The chart above it plots the per-MONTH rate, so
  // the two numbers legitimately differ and both are labelled.
  const capThisTurn = raiseBudget('army', lastTurnDays, pop);

  // No population table means no curve position and no ceiling to speak of:
  // the cap falls back to the flat rule, which is a constant and therefore
  // is not a point on a population curve at all. Plotting it at pop 0, or
  // drawing an empty meter, would both assert a measurement nobody made.
  //
  // The predicate has to be the SAME one menPerMonth and standingArmyCeiling
  // test on (`undefined || !Number.isFinite`), not just the undefined half.
  // A narrower guard here splits the card off from the rule it is quoting: a
  // pop that is present but not a finite number (a hand-edited turn.json
  // carrying "3229802" as a string is the realistic one — JSON cannot spell
  // NaN, but it can spell a string, and nothing between fetchSnapshot and
  // here checks the element type) takes this component's normal branch while
  // both rules take their fail-open one. What renders then is a ceiling of
  // Infinity — `(Infinity).toLocaleString()` is "∞", printed into a stat row
  // — and a marker at cx/cy of NaN, i.e. the two exact outputs this whole
  // file is written to avoid.
  if (pop === undefined || !Number.isFinite(pop)) {
    return (
      <div className={styles.power}>
        <div className={card.row}>
          <span className={card.key}>This turn</span>
          <span className={card.value}>{n(capThisTurn)}</span>
        </div>
        <div className={styles.note}>
          No population figures loaded — the cap is the unscaled flat {n(MEN_PER_MONTH)}
          /month and no standing ceiling applies.
        </div>
      </div>
    );
  }

  const ceiling = standingArmyCeiling(pop);
  const perMonth = menPerMonth(pop);

  // WHAT THE GATE WILL ACTUALLY HONOUR, which is not raiseBudget on its own.
  // checkRaiseBudgets runs TWO tests against an army raise and the ceiling
  // one runs first and outranks the cap (movement.mjs:288-292): every raise
  // is re-checked against the POST-raise standing, so a nation with less
  // headroom than its turn cap is refused at the headroom, and one already
  // at or over its ceiling is refused at zero — even though raiseBudget
  // still returns a comfortable number. Printing that raw number is the one
  // figure on this card a player could act on and collect a 422 for, which
  // is the whole failure this card exists to prevent.
  //
  // Clamping is conservative rather than wrong in the one case where the two
  // come apart: a submission that also SHEDS men (losses, a disband) lowers
  // the standing the gate scores, so more becomes raisable than the headroom
  // showed. That is not a broken promise — `standing` is read live off state,
  // so the moment those men leave the order of battle this number goes up
  // with them.
  const headroom = Math.max(0, ceiling - standing);
  const allowance = Math.min(capThisTurn, headroom);
  // Why the number is lower than the curve above it implies. Without this a
  // player reads "This turn 0" beside a curve labelled "5,994/mo" and has no
  // way to tell which of the three rules bit — and one of the three is the
  // live state today (turn.json ships lastTurnDays 1, so every nation's cap
  // is a legitimate but entirely unexplained 0).
  const capNote =
    capThisTurn === 0
      ? // Math.max(0, …) is not defensiveness, it is the gate's own wording:
        // checkRaiseBudgets clamps the same way before quoting the day count
        // back at the player (movement.mjs:234), so a turn.json with a
        // negative lastTurnDays reads the same in both places.
        `A ${Math.max(0, lastTurnDays)}-day turn is shorter than a whole month, so nothing can be raised until the turn advances.`
      : headroom === 0
        ? `At the standing ceiling — no recruits until the army is back under ${n(ceiling)}.`
        : allowance < capThisTurn
          ? `Ceiling-bound: the turn's cap is ${n(capThisTurn)}, but only ${n(headroom)} more men fit under the ceiling.`
          : null;

  const domainMax = Math.max(X_DOMAIN_FLOOR, pop);
  // The curve's own maximum is the y maximum — the series is monotonic, so
  // it lands exactly in the top-right corner and no plot height is spent on
  // headroom above a line that never gets there.
  const yMax = menPerMonth(domainMax);
  const xOf = (p: number): number => PLOT_X0 + (p / domainMax) * PLOT_W;
  const yOf = (men: number): number => PLOT_Y1 - (men / yMax) * PLOT_H;

  const step = tickStep(yMax);
  const ticks: number[] = [];
  for (let v = 0; v <= yMax; v += step) ticks.push(v);

  // 41 points of cube root on a hover — cheaper than the re-render that
  // carries it, so it is not worth a useMemo and the cache key it would need.
  //
  // i/SAMPLES is warped, not linear, so the samples bunch where the curve
  // bends (see SAMPLE_WARP). Both ends are exact either way: 0 stays 0 and
  // 1 stays 1 under any power, so the path still spans the full domain.
  let curve = '';
  for (let i = 0; i <= SAMPLES; i += 1) {
    const p = (i / SAMPLES) ** SAMPLE_WARP * domainMax;
    curve += `${i === 0 ? 'M' : 'L'}${xOf(p).toFixed(2)} ${yOf(menPerMonth(p)).toFixed(2)}`;
  }

  const dotX = xOf(pop);
  const dotY = yOf(perMonth);
  const refX = xOf(REFERENCE_POP);
  const refY = yOf(MEN_PER_MONTH);

  // Placing the plot's one direct label. There is no tooltip behind it —
  // the card cannot be hovered — so the label has to land somewhere it can
  // actually be read: inside the plot band, and not sitting on the
  // calibration mark. Four placements are tried in order, the two quadrants
  // a RISING curve leaves empty first (above-left, below-right), then the
  // two it runs through, where the label's surface halo is what keeps it
  // legible. All four are needed: a small nation sits bottom-left with no
  // room to its left and none below either, while britain and china sit
  // hard into the top-right corner with no room above or to the right.
  const labelText = `${n(perMonth)}/mo`;
  // Estimated, not measured — there is no text-metrics API to call from a
  // render — and deliberately generous. Over-estimating can only reject a
  // placement that would just have fitted; under-estimating ships a label
  // hanging off the edge of the drawing. 6.0 per character is ~0.6em at
  // .pointLabel's 10px, which no digit in Segoe UI reaches.
  const labelW = labelText.length * 6.0;
  const LABEL_ASCENT = 10;
  // Every offset below is one marker radius (7) plus air, so the label
  // clears the ring rather than resting on it; the downward ones also carry
  // the label's own ascent, because y is a BASELINE and the glyphs grow
  // upward from it back towards the dot.
  // Above-right: the placement the curve is guaranteed to run through, so
  // it is the one that always "works" and therefore the last resort.
  const labelFallback = { x: dotX + 9, y: dotY - 9, anchor: 'start' as const };
  const label =
    [
      { x: dotX - 9, y: dotY - 9, anchor: 'end' as const },
      { x: dotX + 9, y: dotY + 16, anchor: 'start' as const },
      labelFallback,
      { x: dotX - 9, y: dotY + 16, anchor: 'end' as const },
    ].find((c) => {
      const left = c.anchor === 'end' ? c.x - labelW : c.x;
      const top = c.y - LABEL_ASCENT;
      // Bounded by the PLOT, not by the viewBox: a label allowed to spill
      // left would read as a fifth y-axis tick, and one allowed to spill
      // down would collide with the x-axis band.
      if (left < PLOT_X0 - 2 || left + labelW > PLOT_X1 + 2) return false;
      if (top < 2 || c.y > PLOT_Y1 + 2) return false;
      // Clear of the calibration ring (r 3, plus a unit of air) on at least
      // one side. Burying that mark under the label is the exact failure
      // this whole search exists to prevent.
      return (
        left > refX + 4 ||
        left + labelW < refX - 4 ||
        top > refY + 4 ||
        c.y < refY - 4
      );
    }) ?? labelFallback;

  // Standing against ceiling. ceiling is at least MIN_MEN_PER_MONTH here
  // (the undefined case returned above), so this never divides by zero.
  const share = standing / ceiling;
  // The fill is clamped but the number is not: a nation can genuinely be
  // over its ceiling — losing provinces does it without the player acting —
  // and when it is, the gate refuses every recruit. The bar cannot overrun
  // its own track, so the percentage is what has to stay honest.
  const fillW = Math.min(1, share) * VB_W;
  // Rounded, except under 10% where rounding would print "0%" beside a
  // visibly non-empty bar. Nothing is lost either way: the two numbers the
  // percentage is made of are both in the rows underneath.
  const pctText = share > 0 && share < 0.1 ? (share * 100).toFixed(1) : `${Math.round(share * 100)}`;

  return (
    <div className={styles.power}>
      <div className={card.row}>
        <span className={card.key}>Men / month</span>
        {/* Names what is plotted and how, which is why the chart carries no
            legend: one series needs no swatch box to tell it from itself.
            Spelled out rather than set as the &#8731; glyph: U+221B is
            absent from Segoe UI itself and arrives by font fallback, so it
            renders at a different weight and size to the words beside it —
            and on the run of the mill it is a symbol a reader has to decode,
            where "cube root" is simply read. */}
        <span className={styles.headVal}>by cube root of population</span>
      </div>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label={`Men raisable per month against nation population. ${nation} has ${n(pop)} people across all its provinces, and raises ${n(perMonth)} per month.`}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              className={styles.grid}
              x1={PLOT_X0}
              x2={PLOT_X1}
              y1={yOf(v)}
              y2={yOf(v)}
              vectorEffect="non-scaling-stroke"
            />
            {/* -10, not the -5 the gap alone would want: a nation of 0
                people (one the table has but does not list) plots at pop 0,
                which is the y axis itself, and its marker's 7-unit ring
                reaches back over the tick column. */}
            <text className={styles.tick} x={PLOT_X0 - 10} y={yOf(v) + 3} textAnchor="end">

              {n(v)}
            </text>
          </g>
        ))}
        <path className={styles.curve} d={curve} vectorEffect="non-scaling-stroke" />
        {/* The constant the entire curve is quoted from: a nation of exactly
            REFERENCE_POP raises exactly MEN_PER_MONTH, and every other point
            is that figure scaled. Drawn after the line so its surface fill
            punches through — a mark ON the curve, not a bead beside it. */}
        <circle className={styles.refRing} cx={refX} cy={refY} r={3} />
        {/* Ring first, dot on top: 2px of surface between the marker and the
            line it sits on is the only thing keeping it legible there. */}
        <circle className={styles.dotRing} cx={dotX} cy={dotY} r={7} />
        <circle className={styles.dot} cx={dotX} cy={dotY} r={5} />
        <text
          className={styles.pointLabel}
          x={label.x}
          y={label.y}
          textAnchor={label.anchor}
        >
          {labelText}
        </text>
        {/* x axis: the two ends only. The maximum carries the real figure,
            so a domain widened for china says so instead of pretending
            every nation is measured against the same 120M. */}
        <text className={styles.tick} x={PLOT_X0} y={AXIS_BASELINE} textAnchor="start">
          0
        </text>
        <text className={styles.tick} x={PLOT_X1} y={AXIS_BASELINE} textAnchor="end">
          {millions(domainMax)}
        </text>
      </svg>
      {/* The marker's x coordinate, written out. It belongs to the chart —
          it is what the horizontal axis measures and it carries the chart's
          own filled-dot mark — rather than to the stat rows below, which
          are all men and this is people.

          "all provinces" is not padding. The card's fourth row above is
          "Pop. 1800", the hovered PROVINCE's population, and the two
          numbers differ by two orders of magnitude for a nation like china;
          a caption reading only "293,790,263 people" beside it would look
          like the same measurement disagreeing with itself. Naming the
          nation and its scope makes the pair legible as what it is — one
          province, then the whole country it belongs to.

          The figure is deliberately written in full rather than as "293.8M"
          like the axis end: the axis label is squeezed into an 8px tick
          under a plot, this one has a whole line and no reason to round. */}
      <div className={styles.caption}>
        <span className={styles.dotSwatch} />
        <span>
          {nation}, all provinces: {n(pop)} people
        </span>
      </div>
      <div className={styles.caption}>
        <span className={styles.refSwatch} />
        <span>
          {n(REFERENCE_POP / 1e6)}M people = {n(MEN_PER_MONTH)}/month
        </span>
      </div>

      <div className={card.row}>
        <span className={card.key}>Standing army</span>
        <span className={styles.headVal}>{pctText}% of ceiling</span>
      </div>
      <svg className={styles.meter} viewBox={`0 0 ${VB_W} ${METER_H}`} aria-hidden="true">
        <path className={styles.meterTrack} d={barPath(VB_W, METER_H)} />
        <path className={styles.meterFill} d={barPath(fillW, METER_H)} />
      </svg>

      <div className={card.row}>
        <span className={card.key}>This turn</span>
        <span className={card.value}>{n(allowance)}</span>
      </div>
      <div className={card.row}>
        <span className={card.key}>Ceiling</span>
        <span className={card.value}>{n(ceiling)}</span>
      </div>
      <div className={card.row}>
        <span className={card.key}>Under arms</span>
        <span className={card.value}>{n(standing)}</span>
      </div>
      {capNote && <div className={styles.note}>{capNote}</div>}
    </div>
  );
}
