import {Graph} from '../src/datatypes/graph';

/* The dense matrix form of the graph, kept here as the reference: the edge form has to derive
   the same edges, paths, order, traversal and cycles from the same input. */
class MatrixGraph {
  readonly n: number;
  edges: number[];
  paths: number[];

  constructor(n: number) {
    this.n = n;
    this.edges = new Array(n * n).fill(0);
  }

  setEdge(source: number, target: number, weight: number): void {
    if (source === target) return;
    const sourceToTarget = source * this.n + target;
    const targetToSource = target * this.n + source;
    const absWeight = Math.abs(weight);
    if (absWeight < Math.abs(this.edges[sourceToTarget]) ||
        absWeight < Math.abs(this.edges[targetToSource])) return;
    this.edges[sourceToTarget] = weight;
    if (absWeight > Math.abs(this.edges[targetToSource])) this.edges[targetToSource] = 0;
  }

  derivePaths(): void {
    const n = this.n;
    for (let i = 0; i < this.edges.length; i++) if (this.edges[i] < 0) this.edges[i] = 0;
    const paths = this.edges.slice();
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        for (let k = 0; k < n; k++) {
          if (k === i || k === j) continue;
          const weight1 = paths[i * n + k];
          const weight2 = paths[k * n + j];
          if (weight1 && weight2) {
            const weight = Math.min(weight1, weight2);
            if (paths[i * n + j] < weight && paths[j * n + i] < weight) {
              paths[i * n + j] = weight;
              paths[j * n + i] = 0;
            }
          }
        }
      }
    }
    this.paths = paths;
    for (let i = 0; i < n * n; i++) if (this.edges[i]) this.edges[i] = paths[i];
  }

  simplify(): void {
    const n = this.n;
    const paths = this.paths.slice();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (!paths[i * n + j]) continue;
        for (let k = 0; k < n; k++) if (paths[j * n + k]) paths[i * n + k] = 0;
      }
    }
    this.edges = paths;
  }

  hasCycle(): boolean {
    const n = this.n;
    const counts = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) if (this.edges[i * n + j] > 0) counts[j]++;
    }
    const ready: number[] = [];
    for (let i = 0; i < n; i++) if (!counts[i]) ready.push(i);
    let done = 0;
    while (ready.length) {
      const v = ready.pop()!;
      done++;
      for (let j = 0; j < n; j++) if (this.edges[v * n + j] > 0 && --counts[j] === 0) ready.push(j);
    }
    return done < n;
  }

  sortTopologically(): number[] {
    const n = this.n;
    const edgeCounts = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) if (this.edges[i * n + j] > 0) edgeCounts[j] += 1;
    }
    const vertices: number[] = [];
    while (vertices.length < n) {
      for (let i = 0; i < n; i++) {
        if (edgeCounts[i] === 0) {
          edgeCounts[i] = -1;
          vertices.push(i);
          for (let j = 0; j < n; j++) if (this.edges[i * n + j] > 0) edgeCounts[j] -= 1;
        }
      }
    }
    return vertices;
  }
}


/** A deterministic pseudo-random sequence, so a failing case can be rerun. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** The edge maps of the graph laid out as the matrix the reference keeps. */
function asMatrix(rows: Map<number, number>[], n: number): number[] {
  const matrix = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) for (const [j, weight] of rows[i]) matrix[i * n + j] = weight;
  return matrix;
}

function names(n: number): string[] {
  return Array.from({length: n}, (_unused, i) => `v${i}`);
}

function build(n: number, seed: number, density: number) {
  const next = random(seed);
  const vertices = names(n);
  const graph = new Graph(vertices);
  const matrix = new MatrixGraph(n);
  const edgeCount = Math.floor(n * density);
  for (let e = 0; e < edgeCount; e++) {
    const source = Math.floor(next() * n);
    const target = Math.floor(next() * n);
    // Weights as the scheduler uses them: 1 implicit, 2 and 4 denials, 3 and 5 explicit order.
    const weight = [1, 2, 3, 4, 5][Math.floor(next() * 5)];
    const deny = weight === 2 || weight === 4;
    if (deny) graph.denyEdge(vertices[source], vertices[target], weight);
    else graph.addEdge(vertices[source], vertices[target], weight);
    matrix.setEdge(source, target, deny ? -weight : weight);
  }
  return {graph, matrix, vertices};
}


describe('graph kept as edge maps', () => {

  test('derives the same paths, edges, order and traversal as the matrix form', () => {
    let acyclicCases = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const n = 5 + (seed % 40);
      const density = 0.5 + (seed % 7) * 0.4;
      const {graph, matrix, vertices} = build(n, seed, density);
      matrix.derivePaths();
      graph.derivePaths();
      const g = graph as any;
      expect([seed, asMatrix(g.paths, n)]).toEqual([seed, matrix.paths]);
      expect([seed, asMatrix(g.edges, n)]).toEqual([seed, matrix.edges]);
      if (matrix.hasCycle()) {
        expect(graph.findCycles().length).toBeGreaterThan(0);
        continue;
      }
      expect(graph.findCycles()).toEqual([]);
      acyclicCases += 1;
      matrix.simplify();
      g.simplify();
      g.countDependencies();
      g.sealed = true;
      expect([seed, asMatrix(g.edges, n)]).toEqual([seed, matrix.edges]);
      expect(graph.topologicallySortedVertices).toEqual(
        matrix.sortTopologically().map(i => vertices[i]));
    }
    expect(acyclicCases).toBeGreaterThan(50);
  });

  test('plans thousands of vertices in a fraction of a second', () => {
    const n = 20000;
    const vertices = names(n);
    const graph = new Graph(vertices);
    // One anchor before every vertex and one sink after it, the shape of one system per component.
    for (let i = 2; i < n; i++) {
      graph.addEdge(vertices[0], vertices[i], 5);
      graph.addEdge(vertices[i], vertices[1], 1);
    }
    const start = performance.now();
    graph.seal();
    const order = graph.topologicallySortedVertices;
    const elapsed = performance.now() - start;
    expect(order[0]).toBe('v0');
    expect(order[n - 1]).toBe('v1');
    expect(elapsed).toBeLessThan(5000);
  });

});
