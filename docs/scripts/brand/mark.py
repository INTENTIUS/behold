"""behold's small mark: one lens of the logo with its pupil, on a 15x15 tile.

The lens is cut from logo.py's grid (columns 3 to 11, rows 4 to 10), 9x7 art
pixels, centred on the tile; the assert below keeps the two in step. One
character per art pixel: '#' is ink, '.' is empty. Edit the grid, then re-run
generate.sh. Pure pixel SVG, shape-rendering="crispEdges".

    python3 mark.py <fill> <out.svg>

The site draws the mark with CSS mask-image over the gold token, so the fill
only matters to its alpha.
"""
import sys

from logo import GRID as LOGO

GRID = """
...............
...............
...............
...............
.....#####.....
....#.....#....
...#..###..#...
...#..###..#...
...#..###..#...
....#.....#....
.....#####.....
...............
...............
...............
...............
""".strip().splitlines()
W = H = 15
assert len(GRID) == H and all(len(r) == W for r in GRID), "the mark is 15x15"
# The lens sits at the same columns and rows on the tile as in the logo.
assert [row[3:12] for row in GRID[4:11]] == [row[3:12] for row in LOGO[4:11]], "the mark is the logo's left lens"


def mark(fill, out):
    rects = []
    for y, row in enumerate(GRID):
        x = 0
        while x < W:
            if row[x] == "#":
                s = x
                while x < W and row[x] == "#":
                    x += 1
                rects.append(f'<rect x="{s}" y="{y}" width="{x - s}" height="1"/>')
            else:
                x += 1
    with open(out, "w") as f:
        f.write(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
            f'shape-rendering="crispEdges"><g fill="{fill}">{"".join(rects)}</g></svg>\n'
        )


if __name__ == "__main__":
    mark(sys.argv[1], sys.argv[2])
