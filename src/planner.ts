import type {Component, ComponentType} from './component';
import {Graph} from './datatypes/graph';
import {MinHeap} from './datatypes/minheap';
import type {Dispatcher} from './dispatcher';
import type {SystemGroup} from './schedule';
import type {SystemBox} from './system';

export abstract class Plan {
  protected readonly graph: Graph<SystemBox>;

  constructor(protected readonly planner: Planner, protected readonly group: SystemGroup) {
    this.graph = planner.graph.induceSubgraph(group.__systems);
  }

  abstract execute(time: number, delta: number): Promise<void>;
  abstract initialize(): Promise<void>;
  abstract finalize(): Promise<void>;
}


export class SimplePlan extends Plan {
  private readonly systems: SystemBox[];
  /* The positions of the systems that run in every frame, in order, and of the systems that run
     only on changes and were woken. A frame visits these two and nothing else, so a sleeping system
     costs nothing however many there are. */
  private readonly everyFrame: number[] = [];
  private readonly woken = new MinHeap();
  private readonly wokenForNextFrame: number[] = [];
  private readonly queued: Uint8Array;
  private position = -1;

  constructor(protected readonly planner: Planner, protected readonly group: SystemGroup) {
    super(planner, group);
    this.systems = this.graph.topologicallySortedVertices;
    this.queued = new Uint8Array(this.systems.length);
    for (let position = 0; position < this.systems.length; position++) {
      const system = this.systems[position];
      if (system.onlyOnChanges) {
        system.planWakes.push(this, position);
        if (system.woken) this.wakeAt(position);
      } else {
        this.everyFrame.push(position);
      }
    }
    CHECK: if (this.systems.length > 1 && (
      typeof process === 'undefined' || process.env.NODE_ENV === 'development'
    )) {
      console.log('System execution order:');
      for (const system of this.systems) console.log(' ', system.name);
    }
  }

  /**
   * Queues a system that runs only on changes. One woken by a system before it in this frame runs
   * in this frame, one woken by itself or a system after it runs in the next: the frame order a
   * full scan of every system gives.
   */
  wakeAt(position: number): void {
    if (this.queued[position]) return;
    this.queued[position] = 1;
    if (position > this.position) {
      this.woken.push(position);
    } else {
      this.wokenForNextFrame.push(position);
    }
  }

  execute(time: number, delta: number): Promise<void> {
    const dispatcher = this.planner.dispatcher;
    const systems = this.systems;
    const everyFrame = this.everyFrame;
    const woken = this.woken;
    this.group.__executed = true;
    let next = 0;
    while (next < everyFrame.length || woken.size) {
      let position: number;
      if (woken.size && (next === everyFrame.length || woken.peek() < everyFrame[next])) {
        position = woken.pop();
        this.queued[position] = 0;
      } else {
        position = everyFrame[next++];
      }
      this.position = position;
      if (systems[position].execute(time, delta)) dispatcher.flush();
    }
    this.position = -1;
    for (const position of this.wokenForNextFrame) woken.push(position);
    this.wokenForNextFrame.length = 0;
    return Promise.resolve();
  }

  async initialize(): Promise<void> {
    const dispatcher = this.planner.dispatcher;
    this.group.__executed = true;
    return new Promise((resolve, reject) => {
      let rejected = false;

      const initSystem = async (system: SystemBox) => {
        try {
          await system.prepare();
          if (rejected) return;
          system.initialize();
          dispatcher.flush();
          const systems = this.graph.traverse(system);
          if (!systems) return resolve();
          for (let i = 0; i < systems.length; i++) initSystem(systems[i]);
        } catch (e) {
          rejected = true;
          reject(e);
        }
      };

      const systems = this.graph.traverse();
      if (!systems) return resolve();
      for (let i = 0; i < systems.length; i++) initSystem(systems[i]);
    });
  }

  async finalize(): Promise<void> {
    const dispatcher = this.planner.dispatcher;
    this.group.__executed = true;
    return new Promise((resolve, reject) => {
      const finalizeSystem = (system: SystemBox) => {
        try {
          system.finalize();
          dispatcher.flush();
          const systems = this.graph.traverse(system);
          if (!systems) return resolve();
          for (let i = 0; i < systems.length; i++) finalizeSystem(systems[i]);
        } catch (e) {
          reject(e);
        }
      };

      const systems = this.graph.traverse();
      if (!systems) return resolve();
      for (let i = 0; i < systems.length; i++) finalizeSystem(systems[i]);
    });
  }
}


class ThreadedPlan extends Plan {
  execute(time: number, delta: number): Promise<void> {
    return Promise.resolve();
  }

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  finalize(): Promise<void> {
    return Promise.resolve();
  }
}


export class Lane {
  id: number;
  readonly systems: SystemBox[] = [];

  constructor(id: number) {
    this.id = id;
  }

  add(...systems: SystemBox[]): void {
    for (const system of systems) system.lane = this;
    this.systems.push(...systems);
  }

  merge(other: Lane): Lane {
    if (this === other) return this;
    if (this.id === -1 || (other.id !== -1 && other.id < this.id)) return other.merge(this);
    this.add(...other.systems);
    other.systems.length = 0;
    return this;
  }

}


export class Planner {
  readonly graph: Graph<SystemBox>;
  readers? = new Map<ComponentType<Component>, Set<SystemBox>>();
  writers? = new Map<ComponentType<Component>, Set<SystemBox>>();
  lanes: Lane[] = [];
  replicatedLane?: Lane;
  laneCount = 0;

  constructor(
    readonly dispatcher: Dispatcher, private readonly systems: SystemBox[],
    private readonly groups: SystemGroup[]
  ) {
    this.graph = new Graph(systems);
    for (const componentType of dispatcher.registry.types) {
      this.readers!.set(componentType, new Set());
      this.writers!.set(componentType, new Set());
    }
    if (dispatcher.threaded) {
      this.createLane();
      // special lane id, and don't keep this in the lanes array
      this.replicatedLane = new Lane(-1);
    }
  }

  get mainLane(): Lane | undefined {
    return this.lanes[0];
  }

  createLane(): Lane {
    const lane = new Lane(this.laneCount++);
    this.lanes.push(lane);
    return lane;
  }

  organize(): void {
    for (const group of this.groups) group.__collectSystems(this.dispatcher);
    for (const system of this.systems) system.buildQueries();
    for (const system of this.systems) system.buildSchedule();
    for (const group of this.groups) group.__buildSchedule();
    this.addComponentEntitlementDependencies();
    this.graph.seal();
    if (this.dispatcher.threaded) this.assignSystemsToLanes();
    STATS: for (const system of this.systems) system.stats.worker = system.lane?.id ?? 0;
    delete this.readers;
    delete this.writers;
    for (const group of this.groups) {
      group.__plan =
        this.dispatcher.threaded ? new ThreadedPlan(this, group) : new SimplePlan(this, group);
    }
  }

  private addComponentEntitlementDependencies(): void {
    for (const [componentType, systems] of this.readers!.entries()) {
      for (const reader of systems) {
        for (const writer of this.writers!.get(componentType)!) {
          this.graph.addEdge(writer, reader, 1);
        }
      }
    }
  }

  private assignSystemsToLanes(): void {
    this.initSystemLanes();
    this.mergeAccessorsOfUnsharedComponentTypes();
    this.mergeAttachedSystems();
    this.pruneEmptyLanes();
    this.reduceLanes(this.dispatcher.threads + 1);
    this.pruneEmptyLanes();
  }

  private initSystemLanes(): void {
    for (const system of this.systems) {
      if (!system.lane) this.createLane().add(system);
    }
  }

  private mergeAccessorsOfUnsharedComponentTypes(): void {
    for (const componentType of this.dispatcher.registry.types) {
      if (componentType.__binding!.fields.every(field => field.type.shared)) continue;
      const readers = this.readers!.get(componentType);
      const writers = this.writers!.get(componentType);
      if (!readers && !writers) continue;
      let lane = componentType.options?.restrictedToMainThread ? this.mainLane! : this.createLane();
      readers?.forEach(system => {
        lane = lane.merge(system.lane!);
      });
      writers?.forEach(system => {
        lane = lane.merge(system.lane!);
      });
    }
  }

  private mergeAttachedSystems(): void {
    for (const system of this.systems) {
      for (const attachedSystem of system.attachedSystems) {
        if (!attachedSystem) continue;
        system.lane!.merge(attachedSystem.lane!);
      }
    }
  }

  private reduceLanes(maxNumLanes: number): void {
    if (this.lanes.length <= maxNumLanes) return;
    let pairs: {laneA: Lane, laneB: Lane, independence: number}[] = [];
    for (let i = 1; i < this.lanes.length - 1; i++) {  // don't merge into lane 0 unless necessary
      const laneA = this.lanes[i];
      for (let j = i + 1; j < this.lanes.length; j++) {
        const laneB = this.lanes[j];
        pairs.push({laneA, laneB, independence: this.computeIndependence(laneA, laneB)});
      }
    }
    let numLanes = this.lanes.length;
    while (numLanes > maxNumLanes) {
      pairs.sort((pair1, pair2) => pair2.independence - pair1.independence);
      const tangledPair = pairs.pop()!;
      const combinedLane = tangledPair.laneA.merge(tangledPair.laneB);
      const discardedLane =
        combinedLane === tangledPair.laneA ? tangledPair.laneB : tangledPair.laneA;
      numLanes -= 1;
      if (numLanes > maxNumLanes) {
        pairs = pairs.filter(pair => {
          if (pair.laneA === discardedLane || pair.laneB === discardedLane) return false;
          if (pair.laneA === combinedLane || pair.laneB === combinedLane) {
            pair.independence = this.computeIndependence(pair.laneA, pair.laneB);
          }
          return true;
        });
      }
    }
  }

  private computeIndependence(laneA: Lane, laneB: Lane): number {
    return Math.min(
      this.computeIndependentWeight(laneA, laneB), this.computeIndependentWeight(laneB, laneA));
  }

  private computeIndependentWeight(lane: Lane, otherLane: Lane): number {
    let independentWeight = 0;
    for (const system of lane.systems) {
      let otherWeight = 0;
      for (const otherSystem of otherLane.systems) {
        if (!this.graph.hasPath(system, otherSystem) && !this.graph.hasPath(otherSystem, system)) {
          otherWeight += otherSystem.weight;
        }
      }
      independentWeight += Math.min(system.weight, otherWeight);
    }
    return independentWeight;
  }

  private pruneEmptyLanes(): void {
    this.lanes = this.lanes.filter(lane => lane.id === 0 || lane.systems.length);
    // Never prune the main thread lane.
    for (let i = 1; i < this.lanes.length; i++) {
      this.lanes[i].id = i;
    }
  }

}
