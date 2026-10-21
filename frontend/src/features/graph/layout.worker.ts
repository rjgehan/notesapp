// The graph layout worker (ROADMAP item 16, DESIGN §6.28): runs the force simulation off the main
// thread and posts positions as transferable Float32Arrays.
import { DEFAULT_GRAPH_OPTIONS } from './options';
import { LayoutRunner, type LayoutMessage, type PositionsMessage } from './runner';

interface WorkerScope {
  onmessage: ((event: MessageEvent<LayoutMessage>) => void) | null;
  postMessage(message: PositionsMessage, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const runner = new LayoutRunner(DEFAULT_GRAPH_OPTIONS, (message) => scope.postMessage(message, [message.positions.buffer]), 12, 4);
scope.onmessage = (event) => runner.handle(event.data);
