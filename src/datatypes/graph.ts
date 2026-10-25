import {CheckError, InternalError} from '../errors';
import {MinHeap} from './minheap';

interface Printable {
  toString(): string;
}


/**
 * A directed graph with weighted edges and a few extra constraints:
 * 1. Loop edges on a single vertex are not allowed, nor are multiple edges from A to B.
 * 2. An edge from A to B with a higher weight will override an edge from B to A.
 * 3. A "denial" edge from A to B will similarly override lower-weight edges, but not count as an
 *    edge itself.  We store these with negative weights.
 *
 * THE GRAPH KEEPS ITS EDGES, NEVER A MATRIX. Each vertex holds a map from target to weight, so
 * memory and every pass grow with the edges that exist, not with the square of the vertices. A
 * world of three systems and one of many thousands pay per system for its own dependencies.
 * Every pass visits the same pairs in the same order a full matrix scan would and skips only pairs
 * whose weight is zero, so the order it derives is the one the matrix form derived.
 */
export class Graph<V extends Printable> {
  private readonly numVertices: number;
  private edges: Map<number, number>[];
  private paths: Map<number, number>[];
  private readonly vertexIndexMap = new Map<V, number>();
  private sealed = false;
  private sortedVertices: V[];
  private sortedTargets: number[][];
  private readonly dependencyCounts: number[];
  private readonly traversalCounts: number[];
  private numTraversedVertices: number;

  constructor(private readonly vertices: V[]) {
    this.numVertices = vertices.length;
    for (let i = 0; i < vertices.length; i++) {
      this.vertexIndexMap.set(vertices[i], i);
    }
    this.edges = Array.from({length: this.numVertices}, () => new Map<number, number>());
    this.dependencyCounts = new Array(this.numVertices);
    this.traversalCounts = new Array(this.numVertices);
  }

  get topologicallySortedVertices(): V[] {
    DEBUG: if (!this.sealed) throw new InternalError('Graph not yet sealed');
    if (!this.sortedVertices) this.sortedVertices = this.sortTopologically();
    return this.sortedVertices;
  }

  private getVertexId(vertex: V): number {
    const id = this.vertexIndexMap.get(vertex);
    DEBUG: if (id === undefined) throw new InternalError(`Unknown vertex: ${vertex}`);
    return id!;
  }

  private setEdge(source: V, target: V, weight: number): void {
    DEBUG: if (this.sealed) throw new InternalError('Graph already sealed');
    if (source === target) return;
    const sourceId = this.getVertexId(source);
    const targetId = this.getVertexId(target);
    const sourceToTarget = this.edges[sourceId].get(targetId) ?? 0;
    const targetToSource = this.edges[targetId].get(sourceId) ?? 0;
    const absWeight = Math.abs(weight);
    if (absWeight < Math.abs(sourceToTarget) || absWeight < Math.abs(targetToSource)) return;
    this.edges[sourceId].set(targetId, weight);
    if (absWeight > Math.abs(targetToSource)) this.edges[targetId].delete(sourceId);
  }

  addEdge(source: V, target: V, weight: number): void {
    DEBUG: if (weight <= 0) throw new InternalError(`Edge has non-positive weight: ${weight}`);
    this.setEdge(source, target, weight);
  }

  denyEdge(source: V, target: V, weight: number): void {
    DEBUG: if (weight <= 0) throw new InternalError(`Edge has non-positive weight: ${weight}`);
    this.setEdge(source, target, -weight);
  }

  hasEdge(source: V, target: V): boolean {
    return (this.edges[this.getVertexId(source)].get(this.getVertexId(target)) ?? 0) > 0;
  }

  hasPath(source: V, target: V): boolean {
    DEBUG: if (!this.sealed) throw new InternalError('Graph not yet sealed');
    return (this.paths[this.getVertexId(source)].get(this.getVertexId(target)) ?? 0) > 0;
  }

  seal(): void {
    DEBUG: if (this.sealed) throw new InternalError('Graph already sealed');
    this.sealed = true;
    this.derivePaths();
    CHECK: this.checkForCycles();
    this.simplify();
    this.countDependencies();
  }

  private checkForCycles(): void {
    const cycles = this.findCycles();
    if (cycles.length) {
      cycles.sort((x, y) => x.length - y.length);
      throw new CheckError(
        'Precedence cycles detected for the following systems, ' +
        'please resolve by adjusting their schedules: ' +
        cycles.map(cycle => cycle.map(u => u.toString()).join('—')).join(', ')
      );
    }
  }

  /** The targets of every vertex's positive edges, ascending: the order a matrix row is read in. */
  private targetsInOrder(): number[][] {
    return this.edges.map(row => {
      const targets: number[] = [];
      for (const [target, weight] of row) if (weight > 0) targets.push(target);
      return targets.sort((a, b) => a - b);
    });
  }

  /** Whether the positive edges contain a cycle, in one pass over vertices and edges. */
  private hasCycle(targets: number[][]): boolean {
    const counts = new Array<number>(this.numVertices).fill(0);
    for (const row of targets) for (const target of row) counts[target] += 1;
    const ready: number[] = [];
    for (let i = 0; i < this.numVertices; i++) if (!counts[i]) ready.push(i);
    let done = 0;
    while (ready.length) {
      const vertex = ready.pop()!;
      done += 1;
      for (const target of targets[vertex]) if (--counts[target] === 0) ready.push(target);
    }
    return done < this.numVertices;
  }

  findCycles(): V[][] {
    const targets = this.targetsInOrder();
    // An acyclic graph has no circuit to enumerate; the search below is only for the error report.
    if (!this.hasCycle(targets)) return [];

    // This implements Johnson's cycle finding algorithm from
    // https://www.cs.tufts.edu/comp/150GA/homeworks/hw1/Johnson%2075.PDF
    const blocked = new Array<boolean>(this.numVertices).fill(false), b: Set<number>[] = [];
    const stack: number[] = [], cycles: V[][] = [];
    let s: number, vertices: Set<number>;
    for (let i = 0; i < this.numVertices; i++) b[i] = new Set();

    const unblock = (u: number) => {
      blocked[u] = false;
      for (const w of b[u]) {
        b[u].delete(w);
        if (blocked[w]) unblock(w);
      }
    };

    const circuit = (v: number) => {
      let f = false;
      stack.push(v);
      blocked[v] = true;
      for (const w of targets[v]) {
        if (!vertices.has(w)) continue;
        if (w === s) {
          cycles.push(stack.map(u => this.vertices[u]));
          f = true;
        } else if (!blocked[w] && circuit(w)) {
          f = true;
        }
      }
      if (f) {
        unblock(v);
      } else {
        for (const w of targets[v]) {
          if (!vertices.has(w)) continue;
          b[w].add(v);
        }
      }
      stack.pop();
      return f;
    };

    for (s = 0; s < this.numVertices; s++) {
      const componentVertices = this.findLeastStronglyConnectedComponent(s, targets);
      s = componentVertices[0];
      for (const v of componentVertices) {
        blocked[v] = false;
        b[v].clear();
      }
      vertices = new Set(componentVertices);
      circuit(s);
    }

    return cycles;
  }

  private findLeastStronglyConnectedComponent(minId: number, targets: number[][]): number[] {
    // Implements the path-based strong component algorithm on the subgraph consisting of vertices
    // minId through numVertices - 1.
    // https://en.wikipedia.org/wiki/Path-based_strong_component_algorithm
    let leastComponent: number[] | undefined;
    const preorder: number[] = [], s: number[] = [], p: number[] = [];
    const assigned: boolean[] = [];
    let counter = 0;

    const search = (v: number) => {
      preorder[v] = ++counter;
      s.push(v);
      p.push(v);
      for (const w of targets[v]) {
        if (w < minId) continue;
        if (preorder[w]) {
          if (!assigned[w]) {
            while (p.length && preorder[p[p.length - 1]] > preorder[w]) p.pop();
          }
        } else {
          search(w);
        }
      }
      if (p[p.length - 1] === v) {
        const component = [];
        while (true) {
          const w = s.pop()!;
          component.push(w);
          assigned[w] = true;
          if (w === v) break;
        }
        p.pop();
        component.sort((a, b) => a - b);
        if (!leastComponent || component[0] < leastComponent[0]) leastComponent = component;
      }
    };

    for (let i = minId; i < this.numVertices; i++) {
      if (!preorder[i]) search(i);
    }
    return leastComponent!;
  }

  induceSubgraph(subvertices: V[]): Graph<V> {
    const subgraph = new Graph<V>(subvertices);
    const inSubgraph = new Set<number>();
    for (const vertex of subvertices) {
      DEBUG: if (!this.vertexIndexMap.has(vertex)) {
        throw new InternalError(`Vertex not in graph: ${vertex}`);
      }
      inSubgraph.add(this.getVertexId(vertex));
    }
    for (const vertex of subvertices) {
      for (const [targetId, weight] of this.edges[this.getVertexId(vertex)]) {
        if (!inSubgraph.has(targetId)) continue;
        const target = this.vertices[targetId];
        if (weight > 0) {
          subgraph.addEdge(vertex, target, weight);
        } else if (weight < 0) {
          subgraph.denyEdge(vertex, target, -weight);
        }
      }
    }
    if (this.sealed) subgraph.seal();
    return subgraph;
  }

  /**
   * Repeated ascending scans that take every vertex whose count reached zero, the way a scan of the
   * matrix rows does: a vertex freed by one further down the scan is taken in the same scan, one
   * freed further up waits for the next. The heaps hold exactly those two groups.
   */
  private sortTopologically(): V[] {
    const targets = this.sortedTargets;
    const edgeCounts = new Array<number>(this.numVertices).fill(0);
    for (const row of targets) for (const target of row) edgeCounts[target] += 1;
    let thisScan = new MinHeap(), nextScan = new MinHeap();
    for (let i = 0; i < this.numVertices; i++) if (edgeCounts[i] === 0) thisScan.push(i);
    const vertices: V[] = [];
    while (vertices.length < this.numVertices) {
      DEBUG: if (!thisScan.size) {
        throw new InternalError('Graph has a cycle, topological sort not possible');
      }
      while (thisScan.size) {
        const i = thisScan.pop();
        vertices.push(this.vertices[i]);
        for (const j of targets[i]) {
          if (--edgeCounts[j] === 0) (j > i ? thisScan : nextScan).push(j);
        }
      }
      [thisScan, nextScan] = [nextScan, thisScan];
    }
    return vertices;
  }

  derivePaths(): void {
    const n = this.numVertices;

    // Remove denial edges, no longer needed
    for (const row of this.edges) {
      for (const [target, weight] of row) if (weight < 0) row.delete(target);
    }

    /* Derive the path weights with the pass the matrix form ran: for every i in order, every j in
       order, the strongest path i→k→j over all k, taken when it beats both i→j and j→i, which it
       then clears. Within one (i, j) the order of k changes nothing, because the pass writes only
       i→j and j→i and reads neither. A j that no k reaches keeps its weight, so the pass visits
       only the j an out-vertex of i reaches, ascending, and adds the out-vertices of a j it takes
       on the way. */
    const paths = this.edges.map(row => new Map(row));
    const reversed = Array.from({length: n}, () => new Map<number, number>());
    for (let i = 0; i < n; i++) for (const [j, weight] of paths[i]) reversed[j].set(i, weight);
    const queued = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const row = paths[i];
      if (!row.size) continue;
      const candidates = new MinHeap();
      const enqueueTargetsOf = (k: number, after: number) => {
        for (const j of paths[k].keys()) {
          if (j > after && j !== i && !queued[j]) {
            queued[j] = 1;
            candidates.push(j);
          }
        }
      };
      for (const k of row.keys()) enqueueTargetsOf(k, -1);
      while (candidates.size) {
        const j = candidates.pop();
        queued[j] = 0;
        const into = reversed[j];
        let weight = 0;
        if (row.size <= into.size) {
          for (const [k, weight1] of row) {
            if (k === j) continue;
            const weight2 = into.get(k);
            if (weight2) weight = Math.max(weight, Math.min(weight1, weight2));
          }
        } else {
          for (const [k, weight2] of into) {
            if (k === i) continue;
            const weight1 = row.get(k);
            if (weight1) weight = Math.max(weight, Math.min(weight1, weight2));
          }
        }
        if (weight > (row.get(j) ?? 0) && weight > (paths[j].get(i) ?? 0)) {
          const added = !row.has(j);
          row.set(j, weight);
          into.set(i, weight);
          paths[j].delete(i);
          reversed[i].delete(j);
          if (added) enqueueTargetsOf(j, j);
        }
      }
    }
    this.paths = paths;

    // Overwrite edge weights with stronger paths.
    for (let i = 0; i < n; i++) {
      const row = this.edges[i];
      for (const target of row.keys()) row.set(target, paths[i].get(target) ?? 0);
      for (const [target, weight] of row) if (!weight) row.delete(target);
    }
  }

  /**
   * A transitive reduction: for every j in order, every path i→j and j→k removes i→k. It writes
   * only i→k for an i that reaches j and a k that j reaches, never a path into or out of j, so
   * those stay as they are while j is processed.
   */
  private simplify(): void {
    const n = this.numVertices;
    const paths = this.paths.map(row => new Map(row));
    const into = Array.from({length: n}, () => new Set<number>());
    for (let i = 0; i < n; i++) for (const j of paths[i].keys()) into[j].add(i);
    for (let j = 0; j < n; j++) {
      const outOfJ = paths[j];
      if (!outOfJ.size) continue;
      for (const i of into[j]) {
        const row = paths[i];
        for (const k of outOfJ.keys()) {
          if (row.delete(k)) into[k].delete(i);
        }
      }
    }
    this.edges = paths;
    this.sortedTargets = this.targetsInOrder();
  }

  private countDependencies(): void {
    this.dependencyCounts.fill(0);
    for (const row of this.sortedTargets) {
      for (const target of row) this.dependencyCounts[target] += 1;
    }
  }

  /**
   * Traverses vertices of the graph based on dependency order.  When called without an argument it
   * initializes (or re-initializes) the traversal and returns vertices with no dependencies.  When
   * called with an argument, it marks that vertex as done and returns the vertices whose
   * dependencies are all satisfied (if any).
   * @param completedVertex The vertex to mark done; if missing, initializes the traversal instead.
   * @returns The list of vertices whose dependencies have all been satisfied, or `undefined` if
   *    this was the last vertex and the traversal is done.
   */
  traverse(completedVertex?: V): V[] | void {
    DEBUG: if (!this.sealed) throw new InternalError('Graph not yet sealed');
    const traversedVertices = [];
    if (completedVertex) {
      this.numTraversedVertices += 1;
      const sourceId = this.vertexIndexMap.get(completedVertex);
      DEBUG: if (sourceId === undefined) {
        throw new InternalError(`Unknown vertex: ${completedVertex}`);
      }
      for (const i of this.sortedTargets[sourceId!]) {
        if (--this.traversalCounts[i] === 0) {
          traversedVertices.push(this.vertices[i]);
        }
      }
    } else {
      this.numTraversedVertices = 0;
      for (let i = 0; i < this.numVertices; i++) {
        const count = this.traversalCounts[i] = this.dependencyCounts[i];
        if (count === 0) {
          traversedVertices.push(this.vertices[i]);
        }
      }
    }
    if (this.numTraversedVertices === this.numVertices) return;
    return traversedVertices;
  }

  static fromMatrix(matrix: string | number[]): Graph<string> {
    if (typeof matrix === 'string') {
      matrix = matrix.trim().split(/\s+/).map(edge => parseInt(edge, 10));
    }
    const n = Math.sqrt(matrix.length);
    const vertices = [];
    for (let i = 1; i <= n; i++) vertices.push(`v${i}`);
    const graph = new Graph(vertices);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const weight = matrix[i * n + j];
        if (weight) graph.edges[i].set(j, weight);
      }
    }
    return graph;
  }
}
