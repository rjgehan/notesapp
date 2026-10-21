import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeViewer, fakePdfLib, type FakeLib } from '../../test/pdf';
import { PdfController, pdfErrorMessage } from './controller';

let fake: FakeLib;

function mount(controller: PdfController) {
  const container = document.createElement('div');
  const viewer = document.createElement('div');
  container.appendChild(viewer);
  document.body.appendChild(container);
  const unmount = controller.mount(container, viewer);
  return { container, viewer, unmount, pdfViewer: FakeViewer.instances.at(-1)! };
}

async function load(controller: PdfController, pages = 12) {
  const m = mount(controller);
  fake.tasks.at(-1)!.resolve(new FakeDocument(pages));
  await Promise.resolve();
  await Promise.resolve();
  m.pdfViewer.initPages();
  return m;
}

beforeEach(() => {
  fake = fakePdfLib();
  document.body.innerHTML = '';
});

describe('PdfController', () => {
  it('opens the document by its URL with the self-hosted assets and shows the initial page', async () => {
    const controller = new PdfController(fake.lib, '/api/files/raw?path=a.pdf&v=1-2', { initialPage: 5 });
    expect(controller.getState().status).toBe('loading');
    const { pdfViewer } = await load(controller);
    expect(fake.tasks[0].url).toBe('/api/files/raw?path=a.pdf&v=1-2');
    expect(pdfViewer.document?.numPages).toBe(12);
    expect(pdfViewer.currentScaleValue).toBe('auto');
    expect(controller.getState()).toMatchObject({ status: 'ready', pages: 12, page: 5, scaleValue: 'auto' });
  });

  it('clamps an initial page past the end to the last page', async () => {
    const controller = new PdfController(fake.lib, 'u', { initialPage: 99 });
    await load(controller, 3);
    expect(controller.getState().page).toBe(3);
  });

  it('keeps a page asked for while loading until the pages exist', async () => {
    const controller = new PdfController(fake.lib, 'u');
    const m = mount(controller);
    controller.goToPage(4);
    fake.tasks[0].resolve(new FakeDocument(10));
    await Promise.resolve();
    await Promise.resolve();
    m.pdfViewer.initPages();
    expect(controller.getState().page).toBe(4);
    controller.goToPage(0);
    expect(controller.getState().page).toBe(1);
  });

  it('labels the page landmarks', async () => {
    const controller = new PdfController(fake.lib, 'u');
    const container = document.createElement('div');
    const viewer = document.createElement('div');
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.pageNumber = '1';
    viewer.appendChild(page);
    container.appendChild(viewer);
    controller.mount(container, viewer);
    fake.tasks[0].resolve(new FakeDocument(1));
    await Promise.resolve();
    await Promise.resolve();
    FakeViewer.instances[0].initPages();
    expect(page.getAttribute('aria-label')).toBe('Page 1');
  });

  it('reports page and scale changes', async () => {
    const onPageChange = vi.fn();
    const controller = new PdfController(fake.lib, 'u', { onPageChange });
    const { pdfViewer } = await load(controller);
    const listener = vi.fn();
    controller.subscribe(listener);
    pdfViewer.currentPageNumber = 7;
    expect(controller.getState().page).toBe(7);
    expect(onPageChange).toHaveBeenLastCalledWith(7);
    controller.setScaleValue('1.5');
    expect(controller.getState()).toMatchObject({ scale: 1.5, scaleValue: '1.5' });
    controller.setScaleValue('page-fit');
    expect(controller.getState().scaleValue).toBe('page-fit');
    controller.zoomIn();
    expect(controller.getState().scaleValue).toBe(String(pdfViewer.currentScale));
    expect(listener).toHaveBeenCalled();
  });

  it('finds through the viewer’s event bus and follows its match counts', async () => {
    const controller = new PdfController(fake.lib, 'u');
    const { pdfViewer } = await load(controller);
    const bus = pdfViewer.eventBus;
    controller.find('needle');
    expect(bus.dispatched.at(-1)).toMatchObject({ name: 'find', data: { type: '', query: 'needle', highlightAll: true, findPrevious: false, caseSensitive: false } });
    expect(controller.getState().find).toMatchObject({ query: 'needle', result: 'pending' });
    bus.dispatch('updatefindmatchescount', { matchesCount: { current: 1, total: 3 } });
    bus.dispatch('updatefindcontrolstate', { state: 0, matchesCount: { current: 1, total: 3 } });
    expect(controller.getState().find).toEqual({ query: 'needle', current: 1, total: 3, result: 'found' });

    controller.find('needle', { again: true, previous: true });
    expect(bus.dispatched.at(-1)).toMatchObject({ name: 'find', data: { type: 'again', findPrevious: true } });
    expect(controller.getState().find.total).toBe(3);

    bus.dispatch('updatefindcontrolstate', { state: 2, matchesCount: { current: 3, total: 3 } });
    expect(controller.getState().find.result).toBe('wrapped');

    // A new query starts its count over.
    controller.find('other', { again: true });
    expect(bus.dispatched.at(-1)).toMatchObject({ name: 'find', data: { type: '' } });
    expect(controller.getState().find).toMatchObject({ query: 'other', total: 0 });
    bus.dispatch('updatefindcontrolstate', { state: 1 });
    expect(controller.getState().find.result).toBe('not-found');

    controller.find('');
    expect(bus.dispatched.at(-1)?.name).toBe('findbarclose');
    expect(controller.getState().find).toEqual({ query: '', current: 0, total: 0, result: 'idle' });
  });

  it('turns two-finger pinches into scale steps of at least one percent around the fingers', async () => {
    const controller = new PdfController(fake.lib, 'u', { pinch: true });
    const { container, pdfViewer } = await load(controller);
    pdfViewer.currentScaleValue = '1';
    const touch = (x: number, y: number) => ({ clientX: x, clientY: y }) as Touch;
    const fire = (type: string, touches: Touch[]) => {
      const e = new Event(type, { cancelable: true, bubbles: true });
      Object.defineProperty(e, 'touches', { value: touches });
      container.dispatchEvent(e);
      return e;
    };
    expect(fire('touchstart', [touch(100, 100), touch(200, 100)]).defaultPrevented).toBe(true);
    // 0.4 % apart around the same midpoint: not yet a step.
    fire('touchmove', [touch(99.8, 100), touch(200.2, 100)]);
    expect(pdfViewer.updates).toHaveLength(0);
    // 20 % apart, the midpoint moved 10 px right: a step around the new midpoint, panned with it.
    const move = fire('touchmove', [touch(100, 100), touch(220, 100)]);
    expect(move.defaultPrevented).toBe(true);
    expect(pdfViewer.updates).toHaveLength(1);
    expect(pdfViewer.updates[0]).toMatchObject({ drawingDelay: 400, origin: [160, 100], pan: [-10, 0] });
    expect(pdfViewer.currentScale).toBe(1.2);
    fire('touchend', [touch(100, 100)]);
    // One finger scrolls natively.
    expect(fire('touchstart', [touch(100, 100)]).defaultPrevented).toBe(false);
  });

  it('zooms with Ctrl and the wheel, and leaves a plain wheel to scroll', async () => {
    const controller = new PdfController(fake.lib, 'u', { pinch: true });
    const { container, pdfViewer } = await load(controller);
    pdfViewer.currentScaleValue = '1';
    const plain = new WheelEvent('wheel', { deltaY: 100, cancelable: true });
    container.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    const zoom = new WheelEvent('wheel', { deltaY: -50, ctrlKey: true, clientX: 10, clientY: 20, cancelable: true });
    container.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(true);
    expect(pdfViewer.currentScale).toBeCloseTo(1.65, 2);
  });

  it('leaves pinches to the page in embeds', async () => {
    const controller = new PdfController(fake.lib, 'u');
    const { container } = await load(controller);
    const e = new Event('touchstart', { cancelable: true });
    Object.defineProperty(e, 'touches', { value: [{ clientX: 0, clientY: 0 }, { clientX: 10, clientY: 0 }] });
    container.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('asks for a password and passes it on, or shows the error when cancelled', async () => {
    const askPassword = vi.fn().mockResolvedValueOnce('secret').mockResolvedValueOnce(null);
    const controller = new PdfController(fake.lib, 'u', { askPassword });
    mount(controller);
    const task = fake.tasks[0];
    const update = vi.fn();
    task.onPassword!(update, 1);
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith('secret'));
    expect(askPassword).toHaveBeenLastCalledWith(false);
    task.onPassword!(update, 2);
    await vi.waitFor(() => expect(controller.getState().status).toBe('error'));
    expect(askPassword).toHaveBeenLastCalledWith(true);
    expect(controller.getState().error).toBe('This PDF is protected by a password.');
    expect(task.destroyed).toBe(true);
  });

  it('shows why a document could not be opened', async () => {
    const controller = new PdfController(fake.lib, 'u');
    mount(controller);
    fake.tasks[0].reject(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }));
    await vi.waitFor(() => expect(controller.getState().status).toBe('error'));
    expect(controller.getState().error).toBe('This file is not a valid PDF, or it is damaged.');
    expect(pdfErrorMessage(Object.assign(new Error('x'), { name: 'ResponseException' }))).toBe('The file could not be loaded from the server.');
    expect(pdfErrorMessage(new Error('boom'))).toBe('The PDF could not be opened: boom');
    expect(pdfErrorMessage('?')).toBe('The PDF could not be opened.');
  });

  it('destroys the document on unmount and opens it again on the next mount', async () => {
    const controller = new PdfController(fake.lib, 'u');
    const first = mount(controller);
    first.unmount();
    expect(fake.tasks[0].destroyed).toBe(true);
    // A late document of the destroyed task never reaches the new viewer.
    fake.tasks[0].resolve(new FakeDocument(2));
    const second = mount(controller);
    expect(fake.tasks).toHaveLength(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(first.pdfViewer.document).toBeNull();
    expect(second.pdfViewer.document).toBeNull();
    fake.tasks[1].resolve(new FakeDocument(4));
    await Promise.resolve();
    await Promise.resolve();
    second.pdfViewer.initPages();
    expect(controller.getState()).toMatchObject({ status: 'ready', pages: 4 });
    expect(controller.document).not.toBeNull();
  });

  it('refits a preset zoom when the container width changes', async () => {
    const observers: Array<() => void> = [];
    const RealObserver = window.ResizeObserver;
    window.ResizeObserver = class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const controller = new PdfController(fake.lib, 'u');
      const { container, pdfViewer } = await load(controller);
      const set = vi.spyOn(pdfViewer, 'currentScaleValue', 'set');
      Object.defineProperty(container, 'clientWidth', { value: 500, configurable: true });
      observers[0]();
      expect(set).toHaveBeenCalledWith('auto');
      set.mockClear();
      pdfViewer.currentScaleValue = '2';
      set.mockClear();
      Object.defineProperty(container, 'clientWidth', { value: 300, configurable: true });
      observers[0]();
      expect(set).not.toHaveBeenCalled();
    } finally {
      window.ResizeObserver = RealObserver;
    }
  });

  it('passes a drawn thumbnail to the viewer, which frees pages it does not show', async () => {
    const controller = new PdfController(fake.lib, 'u');
    const { pdfViewer } = await load(controller);
    const page = {};
    controller.thumbnailRendered(3, page);
    expect(pdfViewer.eventBus.dispatched.at(-1)).toMatchObject({ name: 'thumbnailrendered', data: { pageNumber: 3, pdfPage: page } });
    expect(controller.pageSize(1)).toEqual({ width: 612 * pdfViewer.currentScale, height: 792 * pdfViewer.currentScale });
    expect(controller.pageSize(99)).toBeNull();
  });
});
