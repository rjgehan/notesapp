// Edges: a Bézier from side to side with optional arrowheads, a wide invisible stroke for hit
// testing, and the label as HTML at the curve's middle. Memoized on the edge and its two end
// rectangles, so dragging a node redraws only the edges attached to it.
import { memo, type CSSProperties } from 'react';
import { arrowHead, cssColor, edgeFromEnd, edgeGeometry, edgeToEnd, isSide, str, type CanvasEdge, type Rect } from './model';

interface Props {
  edge: CanvasEdge;
  from: Rect | undefined;
  to: Rect | undefined;
  selected: boolean;
}

const ARROW = 14;

export const EdgeView = memo(function EdgeView({ edge, from, to, selected }: Props) {
  if (!from || !to) return null;
  const g = edgeGeometry(from, isSide(edge.fromSide) ? edge.fromSide : undefined, to, isSide(edge.toSide) ? edge.toSide : undefined);
  const color = cssColor(edge.color);
  const style = color ? ({ '--canvas-color': color } as CSSProperties) : undefined;
  return (
    <g className={`canvas-edge${selected ? ' is-selected' : ''}${color ? ' has-color' : ''}`} style={style} data-edge-id={edge.id}>
      <path className="canvas-edge-hit" d={g.d} />
      <path className="canvas-edge-line" d={g.d} />
      {edgeToEnd(edge) === 'arrow' && <polygon className="canvas-edge-arrow" points={arrowHead(g.end, g.c2, ARROW)} />}
      {edgeFromEnd(edge) === 'arrow' && <polygon className="canvas-edge-arrow" points={arrowHead(g.start, g.c1, ARROW)} />}
    </g>
  );
});

export const EdgeLabel = memo(function EdgeLabel({ edge, from, to, selected }: Props) {
  const label = str(edge.label);
  if (!from || !to || !label) return null;
  const g = edgeGeometry(from, isSide(edge.fromSide) ? edge.fromSide : undefined, to, isSide(edge.toSide) ? edge.toSide : undefined);
  const color = cssColor(edge.color);
  const style: CSSProperties & Record<string, string | number> = { left: g.mid.x, top: g.mid.y };
  if (color) style['--canvas-color'] = color;
  return (
    <div className={`canvas-edge-label${selected ? ' is-selected' : ''}${color ? ' has-color' : ''}`} style={style} data-edge-id={edge.id}>
      {label}
    </div>
  );
});
