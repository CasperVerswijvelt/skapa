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

// Creates a 2D cross-section for the front cutout (U-shaped opening viewed from front)
async function frontCutoutCrossSection(
  width: number,
  height: number,
  wall: number,
  bottom: number,
  sideOffset: number,
  bottomOffset: number,
  cutoutRadius: number,
): Promise<CrossSection> {
  const { CrossSection } = await ManifoldModule.get();

  // Side edges align with the inner wall (inset by wall thickness)
  const left = -width / 2 + wall + sideOffset;
  const right = width / 2 - wall - sideOffset;
  const bot = bottom + bottomOffset;
  const top = height; // actual box height (extension strip handles the overshoot)

  // Clamp cutout radius to half the opening width/height
  const maxR = Math.min((right - left) / 2, (top - bot) / 2);
  const r = Math.min(cutoutRadius, maxR);

  // Top fillet radius: clamped so outward arcs don't extend past box edge
  const topR = Math.min(r, sideOffset);

  if (r <= 0) {
    // No rounding, simple rectangle — extend past top for clean boolean cut
    const vertices: Vec2[] = [
      [left, bot],
      [right, bot],
      [right, top + BOOLEAN_OVERSHOOT],
      [left, top + BOOLEAN_OVERSHOOT],
    ];
    return new CrossSection(vertices);
  }

  // Build the shape as a single CCW polygon: rounded corners at all 4 corners,
  // with a rectangular "chimney" extension between the top arcs that extends
  // past the box top for a clean boolean cut.
  const vertices: Vec2[] = [];

  // Bottom-left rounded corner (arc from PI to 3PI/2)
  vertices.push(...generateArc({
    center: [left + r, bot + r],
    radius: r,
    startAngle: Math.PI,
    endAngle: (3 * Math.PI) / 2,
  }));

  // Bottom-right rounded corner (arc from 3PI/2 to 2PI)
  vertices.push(...generateArc({
    center: [right - r, bot + r],
    radius: r,
    startAngle: (3 * Math.PI) / 2,
    endAngle: 2 * Math.PI,
  }));

  // Top-right fillet arc: center inside wall at (right+topR, top-topR)
  // CW from PI to PI/2 for tangent continuity with the straight right edge
  if (topR > 0) {
    vertices.push(...generateArc({
      center: [right + topR, top - topR],
      radius: topR,
      startAngle: Math.PI,
      endAngle: Math.PI / 2,
    }));

    // Chimney extension past box top
    vertices.push([right + topR, top + BOOLEAN_OVERSHOOT]);
    vertices.push([left - topR, top + BOOLEAN_OVERSHOOT]);

    // Top-left fillet arc: center inside wall at (left-topR, top-topR)
    // CW from PI/2 to 0 for tangent continuity with the straight left edge
    vertices.push(...generateArc({
      center: [left - topR, top - topR],
      radius: topR,
      startAngle: Math.PI / 2,
      endAngle: 0,
    }));
  } else {
    // No top fillet, straight chimney extension
    vertices.push([right, top + BOOLEAN_OVERSHOOT]);
    vertices.push([left, top + BOOLEAN_OVERSHOOT]);
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
  sideOffset: number,
  bottomOffset: number,
  cutoutRadius: number,
): Promise<Manifold> {
  const cs = await frontCutoutCrossSection(
    width,
    height,
    wall,
    bottom,
    sideOffset,
    bottomOffset,
    cutoutRadius,
  );

  // Extrude along Z, then rotate so it goes along -Y (into the front wall)
  return cs
    .extrude(Math.max(radius, wall) + 2 * BOOLEAN_OVERSHOOT)
    .rotate([90, 0, 0])
    .translate([0, depth / 2 + BOOLEAN_OVERSHOOT, 0]);
}

export type OpenFrontParams = {
  sideOffset: number;
  bottomOffset: number;
  cutoutRadius: number;
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
      openFront.sideOffset,
      openFront.bottomOffset,
      openFront.cutoutRadius,
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

  let res = await base(height, width, depth, radius, wall, bottom, openFront);

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < NV; j++) {
      // For all but the first level, chamfer the clips
      const chamfer = j > 0;
      const [clipL, clipR] = await clips(chamfer);
      res = res.add(clipL.translate(i * gw + dx, -depth / 2, j * gh));
      res = res.add(clipR.translate(i * gw + dx, -depth / 2, j * gh));
    }
  }

  return res;
}
