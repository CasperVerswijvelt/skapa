import type { Vec2, Vec3, CrossSection, Manifold } from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import init from "manifold-3d";
import manifold_wasm from "manifold-3d/manifold.wasm?url";

// NOTE: all values are in mm

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
async function roundedRectangle(
  size: Vec2,
  cornerRadius: number,
): Promise<CrossSection> {
  const { CrossSection } = await ManifoldModule.get();
  const w = size[0];
  const h = size[1];
  const basicArc = generateArc({
    center: [w / 2 - cornerRadius, h / 2 - cornerRadius],
    radius: cornerRadius,
  });

  // Reuse the basic arc and mirror & reverse as necessary for each corner of
  // the cube
  const topRight: Vec2[] = basicArc;
  const topLeft: Vec2[] = Array.from(basicArc.map(([x, y]) => [-x, y]));
  topLeft.reverse();
  const bottomLeft: Vec2[] = basicArc.map(([x, y]) => [-x, -y]);
  const bottomRight: Vec2[] = Array.from(basicArc.map(([x, y]) => [x, -y]));
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
  halfExtent: number,
  height: number,
  bottom: number,
  bottomOffset: number,
  cutoutRadius: number,
  topR: number,
): Promise<CrossSection> {
  const { CrossSection } = await ManifoldModule.get();

  const bot = bottom + bottomOffset;
  const top = height;

  // Clamp cutout radius to geometric limits
  const r = Math.min(cutoutRadius, halfExtent, (top - bot) / 2);

  if (r <= 0) {
    // No rounding, simple rectangle — extend past top for clean boolean cut
    const vertices: Vec2[] = [
      [-halfExtent, bot],
      [halfExtent, bot],
      [halfExtent, top + BOOLEAN_OVERSHOOT],
      [-halfExtent, top + BOOLEAN_OVERSHOOT],
    ];
    return new CrossSection(vertices);
  }

  // Build CCW polygon: U-shape with rounded bottom corners,
  // outward-flaring top corners, and chimney extension at top
  const vertices: Vec2[] = [];

  // Bottom-left rounded corner (arc from PI to 3PI/2) — curves inward
  vertices.push(...generateArc({
    center: [-halfExtent + r, bot + r],
    radius: r,
    startAngle: Math.PI,
    endAngle: (3 * Math.PI) / 2,
  }));

  // Bottom-right rounded corner (arc from 3PI/2 to 2PI) — curves inward
  vertices.push(...generateArc({
    center: [halfExtent - r, bot + r],
    radius: r,
    startAngle: (3 * Math.PI) / 2,
    endAngle: 2 * Math.PI,
  }));

  if (topR > 0) {
    // Top-right concave fillet: center (hE+topR, top-topR), from (hE, top-topR) to (hE+topR, top)
    vertices.push(...generateArc({
      center: [halfExtent + topR, top - topR],
      radius: topR,
      startAngle: Math.PI,
      endAngle: Math.PI / 2,
    }));

    // Chimney right & left (wider by topR)
    vertices.push([halfExtent + topR, top + BOOLEAN_OVERSHOOT]);
    vertices.push([-halfExtent - topR, top + BOOLEAN_OVERSHOOT]);

    // Top-left concave fillet: center (-hE-topR, top-topR), from (-hE-topR, top) to (-hE, top-topR)
    vertices.push(...generateArc({
      center: [-halfExtent - topR, top - topR],
      radius: topR,
      startAngle: Math.PI / 2,
      endAngle: 0,
    }));
  } else {
    // No top rounding — straight chimney at halfExtent
    vertices.push([halfExtent, top + BOOLEAN_OVERSHOOT]);
    vertices.push([-halfExtent, top + BOOLEAN_OVERSHOOT]);
  }

  return new CrossSection(vertices);
}

// Creates a 3D cutout solid for subtracting from the front wall
async function frontCutout(
  height: number,
  width: number,
  depth: number,
  radius: number,
  wall: number,
  bottom: number,
  openness: number,
  bottomOffset: number,
  cutoutRadius: number,
  backFlatAllowance: number,
): Promise<Manifold> {
  // Contour geometry: half-perimeter from center-front going right
  const halfFrontFlat = width / 2 - radius;
  const cornerArc = radius * Math.PI / 2;
  const sideFlat = depth - 2 * radius;
  const maxHalf = halfFrontFlat + cornerArc + sideFlat + cornerArc;
  const halfExtent = openness * maxHalf;

  // Compute top fillet radius: clamp so outward arc doesn't exceed contour bounds
  const bot = bottom + bottomOffset;
  const rClamped = Math.min(cutoutRadius, halfExtent, (height - bot) / 2);
  const topR = Math.min(rClamped, maxHalf + backFlatAllowance - halfExtent);

  const cs = await frontCutoutCrossSection(
    halfExtent,
    height,
    bottom,
    bottomOffset,
    cutoutRadius,
    Math.max(0, topR),
  );

  // Extrude along Z, then rotate so it goes along -Y (into the front wall)
  let cutout = cs
    .extrude(wall + 2 * BOOLEAN_OVERSHOOT)
    .rotate([90, 0, 0])
    .translate([0, depth / 2 + BOOLEAN_OVERSHOOT, 0]);

  const flatBound = halfFrontFlat;
  const needsWarp = (halfExtent + Math.max(0, topR)) > flatBound && radius > 0;

  if (needsWarp) {
    // Refine mesh so the warp has enough vertices for smooth bending
    cutout = cutout.refineToLength(2);

    const cornerCY = depth / 2 - radius;

    const backCornerCY = cornerCY - sideFlat;

    cutout = cutout.warp((v: Vec3) => {
      const x = v[0];
      const y = v[1];
      const absX = Math.abs(x);
      const sign = x >= 0 ? 1 : -1;

      // Region 1: Front flat — no transform
      if (absX <= flatBound) return;

      const arcEnd = flatBound + cornerArc;

      // Region 2: Corner arc — cylindrical bend
      if (absX <= arcEnd) {
        const theta = (absX - flatBound) / radius;
        let rLocal = y - cornerCY;
        // Prevent degenerate triangles when rLocal crosses corner center
        if (rLocal < 0.01) rLocal = 0.01;
        v[0] = sign * (flatBound + rLocal * Math.sin(theta));
        v[1] = cornerCY + rLocal * Math.cos(theta);
        return;
      }

      const sideEnd = arcEnd + sideFlat;

      // Region 3: Side flat — linear remap
      if (absX <= sideEnd) {
        const d = absX - arcEnd;
        const rLocal = y - cornerCY;
        v[0] = sign * (flatBound + rLocal);
        v[1] = cornerCY - d;
        return;
      }

      const backArcEnd = sideEnd + cornerArc;

      // Region 4: Back corner arc — cylindrical bend around back corner center
      if (absX <= backArcEnd) {
        const thetaBack = (absX - sideEnd) / radius;
        const rLocal = y - cornerCY;
        v[0] = sign * (flatBound + rLocal * Math.cos(thetaBack));
        v[1] = backCornerCY - rLocal * Math.sin(thetaBack);
        return;
      }

      // Region 5: Back flat wall — linear remap along back wall
      const dBack = absX - backArcEnd;
      const rLocal = y - cornerCY;
      v[0] = sign * (flatBound - dBack);
      v[1] = backCornerCY - rLocal;
    });
  }

  return cutout;
}

export type OpenFrontParams = {
  openness: number; // fraction 0.05–1.0
  bottomOffset: number;
  cutoutRadius: number;
  backFlatAllowance?: number;
};

// The box (without clips) with origin in the middle of the bottom face
export async function base(
  height: number,
  width: number,
  depth: number,
  radius: number,
  wall: number,
  bottom: number,
  openFront?: OpenFrontParams,
): Promise<Manifold> {
  const innerRadius = Math.max(0, radius - wall);
  const outer = (await roundedRectangle([width, depth], radius)).extrude(
    height,
  );
  const innerNeg = (
    await roundedRectangle([width - 2 * wall, depth - 2 * wall], innerRadius)
  )
    .extrude(height - bottom)
    .translate([0, 0, bottom]);

  let result = outer.subtract(innerNeg);

  if (openFront) {
    const cutout = await frontCutout(
      height,
      width,
      depth,
      radius,
      wall,
      bottom,
      openFront.openness,
      openFront.bottomOffset,
      openFront.cutoutRadius,
      openFront.backFlatAllowance ?? 0,
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
  radius: number,
  wall: number,
  bottom: number,
  openFront?: OpenFrontParams,
  cornerClipsOnly?: boolean,
): Promise<Manifold> {
  const padding = 5; /* mm */
  const W = width - 2 * radius - 2 * padding; // Working area
  const gw = 40; // (horizontal) gap between clip origins
  const N = Math.floor(W / gw + 1); // How many (pairs of) clips we can fit
  const M = N - 1;
  const dx = ((-1 * M) / 2) * gw; // where to place the clips

  // Same as horizontal, but vertically (slightly simpler because we always start
  // from 0 and we don't need to take the radius into account)
  const H = height - CLIP_HEIGHT; // Total height minus clip height
  const gh = 40;
  const NV = Math.floor(H / gh + 1);

  let openFrontAugmented = openFront;
  if (openFront) {
    const flatBound = width / 2 - radius;
    // 3.05 = clip pair half-width (max X in clipRCrossSection)
    const outerClipX = N > 0 ? (M / 2) * gw + 3.05 : 0;
    const backFlatAllowance = Math.max(0, flatBound - outerClipX - 1); // 1mm clearance
    openFrontAugmented = { ...openFront, backFlatAllowance };
  }

  let res = await base(height, width, depth, radius, wall, bottom, openFrontAugmented);

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < NV; j++) {
      if (cornerClipsOnly && !(
        (i === 0 || i === N - 1) && (j === 0 || j === NV - 1)
      )) continue;
      // For all but the first level, chamfer the clips
      const chamfer = j > 0;
      const [clipL, clipR] = await clips(chamfer);
      res = res.add(clipL.translate(i * gw + dx, -depth / 2, j * gh));
      res = res.add(clipR.translate(i * gw + dx, -depth / 2, j * gh));
    }
  }

  return res;
}
