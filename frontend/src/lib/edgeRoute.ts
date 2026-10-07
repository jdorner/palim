/**
 * Orthogonal edge routing for workflow graph edges that span several layout
 * columns.
 *
 * The layout (workflowLayout.ts) lets dagre route long edges: dagre reserves a
 * free slot ("lane") for the edge in every column it crosses, so a path that
 * runs horizontally along those lanes never cuts through a node. The layout
 * hands the lanes to the edge renderer as an {@link EdgeRoute}; the renderer
 * joins them to the live handle positions with vertical segments placed in the
 * gaps between columns.
 */

/**
 * Route through the intermediate columns of a long edge.
 *
 * `lanes[i]` is the y the edge runs along inside the i-th crossed column and
 * `bends[i]` is the x (in the gap before that column) where it turns onto that
 * lane. The final bend sits in the gap before the target's column, so
 * `bends.length === lanes.length + 1`. All coordinates are flow coordinates.
 */
export interface EdgeRoute {
  bends: number[];
  lanes: number[];
}

type Point = [number, number];

/**
 * Builds a rounded orthogonal SVG path from the source handle along a route's
 * lanes to the target handle.
 *
 * @param sx - Source handle x.
 * @param sy - Source handle y.
 * @param tx - Target handle x.
 * @param ty - Target handle y.
 * @param route - Lanes and bends computed by the layout.
 * @param radius - Corner radius in px.
 * @returns `[path, labelX, labelY]`, or null when the route no longer fits the
 *   handle positions (e.g. a node was dragged past a bend), in which case the
 *   caller should fall back to a plain path.
 */
export function routedEdgePath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  route: EdgeRoute,
  radius = 8,
): [string, number, number] | null {
  const { bends, lanes } = route;
  if (lanes.length === 0 || bends.length !== lanes.length + 1) return null;
  if (sx > bends[0]! || tx < bends[bends.length - 1]!) return null;

  const points: Point[] = [[sx, sy]];
  let y = sy;
  for (let i = 0; i < lanes.length; i++) {
    points.push([bends[i]!, y], [bends[i]!, lanes[i]!]);
    y = lanes[i]!;
  }
  const lastBend = bends[bends.length - 1]!;
  points.push([lastBend, y], [lastBend, ty], [tx, ty]);

  // Label on the first lane, centered in the first column the edge crosses.
  const labelX = (bends[0]! + bends[1]!) / 2;
  return [roundedPolyline(simplify(points), radius), labelX, lanes[0]!];
}

/** Drops duplicate points and middle points of straight runs. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5) continue;
    const prev = out[out.length - 2];
    if (prev && last) {
      const collinear =
        (Math.abs(prev[0] - last[0]) < 0.5 && Math.abs(last[0] - p[0]) < 0.5) ||
        (Math.abs(prev[1] - last[1]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5);
      if (collinear) out.pop();
    }
    out.push(p);
  }
  return out;
}

/** Renders a polyline as an SVG path with quadratic-rounded corners. */
function roundedPolyline(points: Point[], radius: number): string {
  const [first] = points;
  if (!first) return "";
  let d = `M ${first[0]} ${first[1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]!;
    const [cx, cy] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    const lenIn = Math.hypot(cx - px, cy - py);
    const lenOut = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, lenIn / 2, lenOut / 2);
    const ax = cx - ((cx - px) / lenIn) * r;
    const ay = cy - ((cy - py) / lenIn) * r;
    const bx = cx + ((nx - cx) / lenOut) * r;
    const by = cy + ((ny - cy) / lenOut) * r;
    d += ` L ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}
