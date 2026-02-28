import type { Vec2, Vec3, CrossSection, Manifold } from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import init from "manifold-3d";
import manifold_wasm from "manifold-3d/manifold.wasm?url";

// NOTE: all values are in mm

export type CornerRadii = {
  frontLeft: number;
  frontRight: number;
  backLeft: number;
  backRight: number;
};

export const CLIP_HEIGHT = 12;

// Load manifold 3d
class ManifoldModule {
  private static wasm: ManifoldToplevel | undefined = undefined;
  static async get(): Promise<ManifoldToplevel> {
    if (this.wasm !== undefined) {
      return this.wasm;
    }

    this.wasm = await init({ locateFile: () => manifold_wasm });

    await this.wasm.setup();
    return this.wasm;
  }
}

// Extra length beyond the box edge for clean boolean subtraction
const BOOLEAN_OVERSHOOT = 1;

// Generates an arc from startAngle to endAngle (CCW when endAngle > startAngle)
function generateArc({
  center,
  radius,
  startAngle = 0,
  endAngle = Math.PI / 2,
  segments = 10,
}: {
  center: Vec2;
  radius: number;
  startAngle?: number;
  endAngle?: number;
  segments?: number;
}): Vec2[] {
  const nPoints = segments + 2;
  const pts: Vec2[] = [];
  for (let i = 0; i < nPoints; i++) {
    const angle = startAngle + (i * (endAngle - startAngle)) / (nPoints - 1);
    pts.push([
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle),
    ]);
  }
  return pts;
}

// Rounded rect centered at (0,0)
// 2D cross-section maps to 3D as (note: +X = viewer's left due to camera):
//   topRight(+X,+Y)=frontLeft, topLeft(-X,+Y)=frontRight,
//   bottomLeft(-X,-Y)=backRight, bottomRight(+X,-Y)=backLeft
//   (positive Y = front face, negative Y = back/clip face)
async function roundedRectangle(
  size: Vec2,
  radii: CornerRadii,
): Promise<CrossSection> {
  const { CrossSection } = await ManifoldModule.get();
  const w = size[0];
  const h = size[1];

  // Generate each corner's arc independently
  const topRight: Vec2[] = generateArc({
    center: [w / 2 - radii.frontLeft, h / 2 - radii.frontLeft],
    radius: radii.frontLeft,
  });

  const topLeft: Vec2[] = Array.from(
    generateArc({
      center: [w / 2 - radii.frontRight, h / 2 - radii.frontRight],
      radius: radii.frontRight,
    }).map(([x, y]) => [-x, y] as Vec2),
  );
  topLeft.reverse();

  const bottomLeft: Vec2[] = generateArc({
    center: [w / 2 - radii.backRight, h / 2 - radii.backRight],
    radius: radii.backRight,
  }).map(([x, y]) => [-x, -y] as Vec2);

  const bottomRight: Vec2[] = Array.from(
    generateArc({
      center: [w / 2 - radii.backLeft, h / 2 - radii.backLeft],
      radius: radii.backLeft,
    }).map(([x, y]) => [x, -y] as Vec2),
  );
  bottomRight.reverse();

  const vertices: Vec2[] = [
    ...topRight,
    ...topLeft,
    ...bottomLeft,
    ...bottomRight,
  ];

  return new CrossSection(vertices);
}

async function clipRCrossSection(): Promise<CrossSection> {
  const { CrossSection } = await ManifoldModule.get();

  const vertices: Vec2[] = [
    [0.95, 0],
    [2.45, 0],
    [2.45, 3.7],
    [3.05, 4.3],
    [3.05, 5.9],
    [2.45, 6.5],
    [0.95, 6.5],
    [0.95, 0],
  ];

  return new CrossSection(vertices).rotate(180);
}

// The skadis clips, starting at the origin and pointing in -Z
// If chamfer is true, the bottom of the clip has a 45 deg chamfer
// (to print without supports)
export async function clips(
  chamfer: boolean = false,
): Promise<[Manifold, Manifold]> {
  const clipR = (await clipRCrossSection()).extrude(CLIP_HEIGHT);
  const clipL = (await clipRCrossSection()).mirror([1, 0]).extrude(CLIP_HEIGHT);

  if (!chamfer) {
    return [clipR, clipL];
  }

  const n: Vec3 = [0, 1, 1]; /* a 45deg normal defining the trim plane */
  return [clipR.trimByPlane(n, 0), clipL.trimByPlane(n, 0)];
}

// Creates a 2D cross-section for the front cutout (U-shaped opening in contour space)
// X-axis = contour distance from center, Y-axis = height
async function frontCutoutCrossSection(
  halfExtent_R: number,
  halfExtent_L: number,
  height: number,
  bottom: number,
  bottomOffset: number,
  cutoutRadius: number,
  topR: number,
): Promise<CrossSection> {
  const { CrossSection } = await ManifoldModule.get();

  const bot = bottom + bottomOffset;
  const top = height;

  // Clamp cutout radius to geometric limits (both sides)
  const r = Math.min(cutoutRadius, halfExtent_R, halfExtent_L, (top - bot) / 2);

  if (r <= 0) {
    // No rounding, simple rectangle — extend past top for clean boolean cut
    const vertices: Vec2[] = [
      [-halfExtent_L, bot],
      [halfExtent_R, bot],
      [halfExtent_R, top + BOOLEAN_OVERSHOOT],
      [-halfExtent_L, top + BOOLEAN_OVERSHOOT],
    ];
    return new CrossSection(vertices);
  }

  // Build CCW polygon: U-shape with rounded bottom corners,
  // outward-flaring top corners, and chimney extension at top
  const vertices: Vec2[] = [];

  // Bottom-left rounded corner (arc from PI to 3PI/2) — curves inward
  vertices.push(...generateArc({
    center: [-halfExtent_L + r, bot + r],
    radius: r,
    startAngle: Math.PI,
    endAngle: (3 * Math.PI) / 2,
  }));

  // Bottom-right rounded corner (arc from 3PI/2 to 2PI) — curves inward
  vertices.push(...generateArc({
    center: [halfExtent_R - r, bot + r],
    radius: r,
    startAngle: (3 * Math.PI) / 2,
    endAngle: 2 * Math.PI,
  }));

  if (topR > 0) {
    // Top-right concave fillet
    vertices.push(...generateArc({
      center: [halfExtent_R + topR, top - topR],
      radius: topR,
      startAngle: Math.PI,
      endAngle: Math.PI / 2,
    }));

    // Chimney right & left (wider by topR)
    vertices.push([halfExtent_R + topR, top + BOOLEAN_OVERSHOOT]);
    vertices.push([-halfExtent_L - topR, top + BOOLEAN_OVERSHOOT]);

    // Top-left concave fillet
    vertices.push(...generateArc({
      center: [-halfExtent_L - topR, top - topR],
      radius: topR,
      startAngle: Math.PI / 2,
      endAngle: 0,
    }));
  } else {
    // No top rounding — straight chimney
    vertices.push([halfExtent_R, top + BOOLEAN_OVERSHOOT]);
    vertices.push([-halfExtent_L, top + BOOLEAN_OVERSHOOT]);
  }

  return new CrossSection(vertices);
}

// Creates a 3D cutout solid for subtracting from the front wall
async function frontCutout(
  height: number,
  width: number,
  depth: number,
  radii: CornerRadii,
  wall: number,
  bottom: number,
  openness: number,
  bottomOffset: number,
  cutoutRadius: number,
  backFlatAllowance_R: number,
  backFlatAllowance_L: number,
): Promise<Manifold> {
  // Per-side contour geometry
  // Note: +X = viewer's left due to camera, so x >= 0 side uses frontLeft/backLeft
  const rFL = radii.frontLeft;
  const rBL = radii.backLeft;
  const rFR = radii.frontRight;
  const rBR = radii.backRight;

  // Right side in geometry (x >= 0) = viewer's left
  const halfFrontFlat_R = width / 2 - rFL;
  const cornerArc_R = rFL * Math.PI / 2;
  const sideFlat_R = depth - rFL - rBL;
  const backArc_R = rBL * Math.PI / 2;
  const maxHalf_R = halfFrontFlat_R + cornerArc_R + sideFlat_R + backArc_R;

  // Left side in geometry (x < 0) = viewer's right
  const halfFrontFlat_L = width / 2 - rFR;
  const cornerArc_L = rFR * Math.PI / 2;
  const sideFlat_L = depth - rFR - rBR;
  const backArc_L = rBR * Math.PI / 2;
  const maxHalf_L = halfFrontFlat_L + cornerArc_L + sideFlat_L + backArc_L;

  // Per-side clip limits
  const clipLimit_R = maxHalf_R + backFlatAllowance_R;
  const clipLimit_L = maxHalf_L + backFlatAllowance_L;
  const bot = bottom + bottomOffset;
  const rClamped = Math.min(cutoutRadius, (height - bot) / 2, clipLimit_R, clipLimit_L);
  const effectiveMax_R = Math.max(0, clipLimit_R - rClamped);
  const effectiveMax_L = Math.max(0, clipLimit_L - rClamped);
  const halfExtent_R = openness * effectiveMax_R;
  const halfExtent_L = openness * effectiveMax_L;
  const topR = rClamped;

  const cs = await frontCutoutCrossSection(
    halfExtent_R,
    halfExtent_L,
    height,
    bottom,
    bottomOffset,
    cutoutRadius,
    topR,
  );

  // Extrude along Z, then rotate so it goes along -Y (into the front wall)
  let cutout = cs
    .extrude(wall + 2 * BOOLEAN_OVERSHOOT)
    .rotate([90, 0, 0])
    .translate([0, depth / 2 + BOOLEAN_OVERSHOOT, 0]);

  // Check if warp is needed for either side
  const flatBound_R = halfFrontFlat_R;
  const flatBound_L = halfFrontFlat_L;
  const needsWarp =
    ((halfExtent_R + topR) > flatBound_R && rFL > 0) ||
    ((halfExtent_L + topR) > flatBound_L && rFR > 0);

  if (needsWarp) {
    // Refine mesh so the warp has enough vertices for smooth bending
    cutout = cutout.refineToLength(2);

    // Per-side corner center Y positions
    const cornerCY_R = depth / 2 - rFL;
    const backCornerCY_R = -depth / 2 + rBL;
    const cornerCY_L = depth / 2 - rFR;
    const backCornerCY_L = -depth / 2 + rBR;

    cutout = cutout.warp((v: Vec3) => {
      const x = v[0];
      const y = v[1];
      const absX = Math.abs(x);
      const sign = x >= 0 ? 1 : -1;

      // Select per-side parameters
      const params = x >= 0
        ? {
            flatBound: flatBound_R,
            cornerArc: cornerArc_R,
            sideFlat: sideFlat_R,
            backArc: backArc_R,
            frontR: rFL,
            backR: rBL,
            cornerCY: cornerCY_R,
            backCornerCY: backCornerCY_R,
          }
        : {
            flatBound: flatBound_L,
            cornerArc: cornerArc_L,
            sideFlat: sideFlat_L,
            backArc: backArc_L,
            frontR: rFR,
            backR: rBR,
            cornerCY: cornerCY_L,
            backCornerCY: backCornerCY_L,
          };

      // Region 1: Front flat — no transform
      if (absX <= params.flatBound) return;

      const arcEnd = params.flatBound + params.cornerArc;

      // Region 2: Corner arc — cylindrical bend
      if (absX <= arcEnd && params.frontR > 0) {
        const theta = (absX - params.flatBound) / params.frontR;
        let rLocal = y - params.cornerCY;
        // Prevent degenerate triangles when rLocal crosses corner center
        if (rLocal < 0.01) rLocal = 0.01;
        v[0] = sign * (params.flatBound + rLocal * Math.sin(theta));
        v[1] = params.cornerCY + rLocal * Math.cos(theta);
        return;
      }

      const sideEnd = arcEnd + params.sideFlat;

      // Region 3: Side flat — linear remap
      if (absX <= sideEnd) {
        const d = absX - arcEnd;
        const rLocal = y - params.cornerCY;
        v[0] = sign * (params.flatBound + rLocal);
        v[1] = params.cornerCY - d;
        return;
      }

      const backArcEnd = sideEnd + params.backArc;

      // Region 4: Back corner arc — cylindrical bend around back corner center
      if (absX <= backArcEnd && params.backR > 0) {
        const thetaBack = (absX - sideEnd) / params.backR;
        const rLocal = y - params.cornerCY;
        v[0] = sign * (params.flatBound + rLocal * Math.cos(thetaBack));
        v[1] = params.backCornerCY - rLocal * Math.sin(thetaBack);
        return;
      }

      // Region 5: Back flat wall — linear remap along back wall
      const dBack = absX - backArcEnd;
      const rLocal = y - params.cornerCY;
      v[0] = sign * (params.flatBound - dBack);
      v[1] = params.backCornerCY - rLocal;
    });
  }

  return cutout;
}

export type OpenFrontParams = {
  openness: number; // fraction 0.05–1.0
  bottomOffset: number;
  cutoutRadius: number;
  backFlatAllowance_R?: number;
  backFlatAllowance_L?: number;
};

// The box (without clips) with origin in the middle of the bottom face
export async function base(
  height: number,
  width: number,
  depth: number,
  radii: CornerRadii,
  wall: number,
  bottom: number,
  openFront?: OpenFrontParams,
): Promise<Manifold> {
  const innerRadii: CornerRadii = {
    frontLeft: Math.max(0, radii.frontLeft - wall),
    frontRight: Math.max(0, radii.frontRight - wall),
    backLeft: Math.max(0, radii.backLeft - wall),
    backRight: Math.max(0, radii.backRight - wall),
  };
  const outer = (await roundedRectangle([width, depth], radii)).extrude(
    height,
  );
  const innerNeg = (
    await roundedRectangle([width - 2 * wall, depth - 2 * wall], innerRadii)
  )
    .extrude(height - bottom)
    .translate([0, 0, bottom]);

  let result = outer.subtract(innerNeg);

  if (openFront) {
    const cutout = await frontCutout(
      height,
      width,
      depth,
      radii,
      wall,
      bottom,
      openFront.openness,
      openFront.bottomOffset,
      openFront.cutoutRadius,
      openFront.backFlatAllowance_R ?? 0,
      openFront.backFlatAllowance_L ?? 0,
    );
    result = result.subtract(cutout);
  }

  return result;
}

// The box (with clips), with origin where clips meet the box
export async function box(
  height: number,
  width: number,
  depth: number,
  radii: CornerRadii,
  wall: number,
  bottom: number,
  openFront?: OpenFrontParams,
  cornerClipsOnly?: boolean,
): Promise<Manifold> {
  const padding = 5; /* mm */
  const W = width - radii.backLeft - radii.backRight - 2 * padding; // Working area
  const gw = 40; // (horizontal) gap between clip origins
  const N = Math.floor(W / gw + 1); // How many (pairs of) clips we can fit
  const M = N - 1;
  const dx = ((-1 * M) / 2) * gw; // where to place the clips

  // Center of the flat back region (may be off-center when radii differ)
  const backFlatCenter = (radii.backRight - radii.backLeft) / 2;

  // Same as horizontal, but vertically (slightly simpler because we always start
  // from 0 and we don't need to take the radius into account)
  const H = height - CLIP_HEIGHT; // Total height minus clip height
  const gh = 40;
  const NV = Math.floor(H / gh + 1);

  let openFrontAugmented = openFront;
  if (openFront) {
    // Per-side flat bounds: warp Region 5 maps back-flat X from halfFrontFlat
    const warpFlatBound_R = width / 2 - radii.frontLeft;
    const warpFlatBound_L = width / 2 - radii.frontRight;
    // Per-side clip edges: account for backFlatCenter shift (2.45 = clip wall-surface footprint)
    const outerClipX_R = N > 0 ? Math.max(0, (M / 2) * gw + backFlatCenter + 2.45) : 0;
    const outerClipX_L = N > 0 ? Math.max(0, (M / 2) * gw - backFlatCenter + 2.45) : 0;
    const backFlatAllowance_R = Math.max(0, warpFlatBound_R - outerClipX_R - 1); // 1mm clearance
    const backFlatAllowance_L = Math.max(0, warpFlatBound_L - outerClipX_L - 1);
    openFrontAugmented = { ...openFront, backFlatAllowance_R, backFlatAllowance_L };
  }

  let res = await base(height, width, depth, radii, wall, bottom, openFrontAugmented);

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < NV; j++) {
      if (cornerClipsOnly && !(
        (i === 0 || i === N - 1) && (j === 0 || j === NV - 1)
      )) continue;
      // For all but the first level, chamfer the clips
      const chamfer = j > 0;
      const [clipL, clipR] = await clips(chamfer);
      res = res.add(clipL.translate(i * gw + dx + backFlatCenter, -depth / 2, j * gh));
      res = res.add(clipR.translate(i * gw + dx + backFlatCenter, -depth / 2, j * gh));
    }
  }

  return res;
}
