/**
 * VisualContinuityPackage
 *
 * A full-video plan used to describe continuity as a single string such as
 * `same tabletop`.  That is too shallow to make independently generated clips
 * feel like one commercial.  This module is the single, provider-neutral
 * source of truth for the visual bible and every shot boundary:
 *
 * - the invariants that must not drift (product, set, light, palette, lens),
 * - what the outgoing frame must hand to the next shot,
 * - how that handoff is stitched, and
 * - the exact prompt fragment that carries the contract into generation.
 *
 * It deliberately does not call a model or inspect files.  That keeps the
 * contract deterministic, serializable in the plan, and testable before a
 * paid generation is made.
 */

export const VISUAL_CONTINUITY_PROMPT_MARKER = 'Visual continuity contract v1';

export type VisualSeamStrategy = 'match_cut' | 'dissolve' | 'fade';

export interface VisualContinuityShotInput {
  shotId: string;
  shotIndex: number;
  beat: string;
  continuityGroup: string;
  preState?: string;
  postState?: string;
  cameraDirection?: string;
}

export interface VisualBible {
  /** The supplied product asset, rather than a source-video identity, is canonical. */
  productIdentity: string;
  setAndProps: string;
  lighting: string;
  palette: string;
  cameraLanguage: string;
  motionLanguage: string;
  forbiddenDrift: string[];
}

export interface VisualSeam {
  fromShotIndex: number;
  toShotIndex: number;
  strategy: VisualSeamStrategy;
  /** At least two visual facts that both sides of the cut must share. */
  sharedAnchors: string[];
  outgoingVisualState: string;
  incomingVisualState: string;
  /** A targeted instruction for regenerating only the broken boundary. */
  repairPrompt: string;
}

export interface VisualContinuityPackage {
  version: 'v1';
  continuityGroup: string;
  visualBible: VisualBible;
  seams: VisualSeam[];
}

function normalized(value: string | undefined, fallback: string): string {
  const text = String(value || '').trim();
  return text || fallback;
}

function strategyFor(fromBeat: string, toBeat: string, sameGroup: boolean): VisualSeamStrategy {
  if (!sameGroup) return 'fade';
  if (
    (fromBeat === 'proof' && (toBeat === 'benefit' || toBeat === 'cta')) ||
    (fromBeat === 'benefit' && toBeat === 'cta')
  ) {
    return 'dissolve';
  }
  return 'match_cut';
}

function boundaryAnchors(fromBeat: string, toBeat: string, bible: VisualBible): string[] {
  const anchors = [
    bible.productIdentity,
    bible.setAndProps,
    bible.lighting,
    bible.palette,
  ];

  if (fromBeat === 'product_intro' && toBeat === 'demo') {
    anchors.push('the same product nozzle and the same left-to-right action direction carry into the use demonstration');
  } else if (fromBeat === 'demo' && toBeat === 'proof') {
    anchors.push('the foam trail and ceramic surface visibly evolve into the clean result; do not reset to a new surface');
  } else if (fromBeat === 'proof' && (toBeat === 'benefit' || toBeat === 'cta')) {
    anchors.push('the observed clean result remains visible while the camera opens into the product hero composition');
  } else if (toBeat === 'cta') {
    anchors.push('the same final product and result settle into a stable hero hold; do not introduce a new prop or action');
  } else {
    anchors.push('the subject position and camera travel direction continue through the cut instead of restarting the scene');
  }

  return anchors;
}

/** Build a visual bible plus one explicit, meaningful contract for every cut. */
export function createVisualContinuityPackage(input: {
  productName: string;
  shots: VisualContinuityShotInput[];
  /** Safe, technique-only findings from the source semantic storyboard. */
  visualGrammar?: Partial<{
    pacing: string;
    cameraLanguage: string;
    composition: string;
    transitionLanguage: string;
  }>;
}): VisualContinuityPackage {
  const productName = normalized(input.productName, 'the supplied product');
  const firstGroup = normalized(input.shots[0]?.continuityGroup, 'product-commercial-v1');
  const bible: VisualBible = {
    productIdentity: `the exact supplied ${productName} package geometry, label layout, material finish, and primary brand colors`,
    setAndProps: normalized(
      input.visualGrammar?.composition,
      'one neutral warm ceramic tabletop with the same restrained foam and cleaning props; no new room, person, or unrelated hero prop'
    ) + '; keep one controlled product-safe set rather than copying source identities or locations',
    lighting: 'soft directional daylight from the same side, with a stable warm-white exposure and consistent soft shadow direction',
    palette: 'the supplied product palette remains dominant against warm neutral ceramic; no sudden palette or white-balance shift',
    cameraLanguage: normalized(
      input.visualGrammar?.cameraLanguage,
      'vertical commercial product cinematography with a stable horizon, controlled macro focus, and no random lens jump'
    ),
    motionLanguage: normalized(
      [input.visualGrammar?.pacing, input.visualGrammar?.transitionLanguage].filter(Boolean).join('; '),
      'one deliberate action direction per beat; acceleration settles before the next cut and no motion reverses without a narrative reason'
    ),
    forbiddenDrift: [
      'do not change the product package, label, scale, cap, nozzle, or primary colors',
      'do not change to a new location, table material, time of day, or lighting direction',
      'do not introduce a person, hand, face, competitor item, source subtitle, watermark, or unrelated decorative prop',
      'do not reset an already demonstrated surface state at the next shot',
    ],
  };

  const seams: VisualSeam[] = [];
  for (let index = 1; index < input.shots.length; index += 1) {
    const previous = input.shots[index - 1];
    const next = input.shots[index];
    const strategy = strategyFor(previous.beat, next.beat, previous.continuityGroup === next.continuityGroup);
    const outgoing = normalized(previous.postState, `the result of shot ${previous.shotIndex} remains visible`);
    const incoming = normalized(next.preState, `continue the result delivered by shot ${previous.shotIndex}`);
    const sharedAnchors = boundaryAnchors(previous.beat, next.beat, bible);
    seams.push({
      fromShotIndex: previous.shotIndex,
      toShotIndex: next.shotIndex,
      strategy,
      sharedAnchors,
      outgoingVisualState: outgoing,
      incomingVisualState: incoming,
      repairPrompt:
        `Repair only the boundary from shot ${previous.shotIndex} to shot ${next.shotIndex}: ` +
        `end on "${outgoing}" and begin on "${incoming}" while preserving ${sharedAnchors.slice(0, 3).join('; ')}. ` +
        `Use a ${strategy.replace('_', ' ')}; do not regenerate unrelated shots.`,
    });
  }

  return {
    version: 'v1',
    continuityGroup: firstGroup,
    visualBible: bible,
    seams,
  };
}

export function getVisualSeam(
  visualContinuity: VisualContinuityPackage | undefined,
  fromShotIndex: number,
  toShotIndex: number
): VisualSeam | undefined {
  return visualContinuity?.seams.find(
    (seam) => seam.fromShotIndex === fromShotIndex && seam.toShotIndex === toShotIndex
  );
}

/**
 * Append the generated shot's part of the shared contract.  Keeping this here
 * prevents the runner, workbench, and retry paths from inventing different
 * continuity prompt wording.
 */
export function appendVisualContinuityPrompt(input: {
  basePrompt: string;
  package: VisualContinuityPackage;
  shot: VisualContinuityShotInput;
}): string {
  const incoming = getVisualSeam(input.package, input.shot.shotIndex - 1, input.shot.shotIndex);
  const outgoing = getVisualSeam(input.package, input.shot.shotIndex, input.shot.shotIndex + 1);
  const bible = input.package.visualBible;
  const lines = [
    VISUAL_CONTINUITY_PROMPT_MARKER + '.',
    `Visual bible: ${bible.productIdentity}; ${bible.setAndProps}; ${bible.lighting}; ${bible.palette}; ${bible.cameraLanguage}; ${bible.motionLanguage}.`,
    incoming
      ? `Entry seam from shot ${incoming.fromShotIndex}: inherit "${incoming.outgoingVisualState}" as "${incoming.incomingVisualState}". Shared anchors: ${incoming.sharedAnchors.join('; ')}. Use ${incoming.strategy.replace('_', ' ')}.`
      : 'Opening frame: establish the visual bible before introducing any new action.',
    outgoing
      ? `Exit seam to shot ${outgoing.toShotIndex}: finish with "${outgoing.outgoingVisualState}" so the next shot can begin with "${outgoing.incomingVisualState}". Preserve: ${outgoing.sharedAnchors.join('; ')}.`
      : 'Closing frame: settle the established product and result into a stable final hero hold.',
    `Never drift: ${bible.forbiddenDrift.join('; ')}.`,
  ];
  return `${input.basePrompt.trim()} ${lines.join(' ')}`.trim();
}

/** Validate a package against the approved shot order before generation or QA. */
export function validateVisualContinuityPackage(
  visualContinuity: VisualContinuityPackage,
  shots: VisualContinuityShotInput[]
): string[] {
  const errors: string[] = [];
  if (visualContinuity.version !== 'v1') errors.push('unsupported visual continuity package version');
  if (!visualContinuity.continuityGroup.trim()) errors.push('visual continuity group is missing');
  const bible = visualContinuity.visualBible;
  for (const [key, value] of Object.entries(bible)) {
    if (Array.isArray(value)) {
      if (value.length === 0 || value.some((item) => !String(item).trim())) {
        errors.push(`visual bible ${key} is incomplete`);
      }
    } else if (!String(value || '').trim()) {
      errors.push(`visual bible ${key} is incomplete`);
    }
  }
  if (visualContinuity.seams.length !== Math.max(0, shots.length - 1)) {
    errors.push('visual continuity seam count does not match shot boundaries');
  }
  for (let index = 1; index < shots.length; index += 1) {
    const previous = shots[index - 1];
    const next = shots[index];
    const seam = getVisualSeam(visualContinuity, previous.shotIndex, next.shotIndex);
    if (!seam) {
      errors.push(`missing visual continuity seam ${previous.shotIndex}->${next.shotIndex}`);
      continue;
    }
    if (!['match_cut', 'dissolve', 'fade'].includes(seam.strategy)) {
      errors.push(`visual continuity seam ${previous.shotIndex}->${next.shotIndex} has an invalid strategy`);
    }
    if (seam.sharedAnchors.length < 2 || seam.sharedAnchors.some((anchor) => !anchor.trim())) {
      errors.push(`visual continuity seam ${previous.shotIndex}->${next.shotIndex} has too few shared anchors`);
    }
    if (!seam.outgoingVisualState.trim() || !seam.incomingVisualState.trim()) {
      errors.push(`visual continuity seam ${previous.shotIndex}->${next.shotIndex} has no visual state handoff`);
    }
    if (!seam.repairPrompt.trim()) {
      errors.push(`visual continuity seam ${previous.shotIndex}->${next.shotIndex} has no local repair prompt`);
    }
  }
  return errors;
}
