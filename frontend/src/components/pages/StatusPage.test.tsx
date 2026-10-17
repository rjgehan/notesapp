import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import type { StatusDetails, StatusResponse } from '../../api/types';
import { registerBuiltins } from '../../extensions/builtins';
import { registeredPages } from '../../extensions';
import { openPath } from '../../features/navigation';
import { useToasts } from '../../state/toasts';
import StatusPage from './StatusPage';

vi.mock('../../features/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/navigation')>()),
  openPath: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function data(): { status: StatusResponse; details: StatusDetails } {
  const vault = new MockVault();
  const status = vault.getStatus();
  const details = vault.getStatusDetails();
  return {
    status: { ...status, startedAt: hoursAgo(5), buildSha: '4e1f0c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f' },
    details: {
      ...details,
      runtime: { javaVersion: '25.0.4.1+1-LTS', javaVendor: 'Eclipse Adoptium', aotCache: 'in-use', heapUsedBytes: 80 * 1024 ** 2, heapMaxBytes: 768 * 1024 ** 2, processors: 4 },
      events: { clients: 3 },
      git: { commits: 4312, commitsThisRun: 12, failedCommitsThisRun: 0, largeFiles: [{ path: 'Media/Talk.mp4', bytes: 300 * 1024 ** 2 }], largeFilesTruncated: false },
      backup: { state: 'ok', reason: null, lastRun: hoursAgo(6), lastSuccess: hoursAgo(6), snapshot: '4f1c2a9b', offsite: 'ok', failures: null },
      alerts: {
        state: 'on',
        reason: null,
        server: 'https://ntfy.sh',
        sent: 2,
        dropped: 0,
        lastSentAt: hoursAgo(1),
        lastError: null,
        lastErrorAt: null,
        recent: [{ marker: 'GIT_MIRROR_FAILED', count: 2, lastAt: hoursAgo(1) }],
      },
    },
  };
}

function renderPage(status: StatusResponse, details: StatusDetails) {
  vi.spyOn(api, 'getStatus').mockResolvedValue(status);
  vi.spyOn(api, 'getStatusDetails').mockResolvedValue(details);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const card = (name: string) => screen.getByRole('region', { name });

describe('StatusPage (ROADMAP item 38)', () => {
  it('is registered as a page with a palette command', () => {
    registerBuiltins();
    const page = registeredPages().find((p) => p.route === 'status');
    expect(page?.title).toBe('Status');
  });

  it('shows the server, history, disk, sync, backups and alerts', async () => {
    const { status, details } = data();
    renderPage(status, details);
    expect(await screen.findByText('Everything is working.')).toBeInTheDocument();

    const server = card('Server');
    expect(within(server).getByText('4e1f0c2a9b8d')).toBeInTheDocument();
    expect(within(server).getByText('5 hours')).toBeInTheDocument();
    expect(within(server).getByText('25.0.4.1+1-LTS (Eclipse Adoptium)')).toBeInTheDocument();
    expect(within(server).getByText('in use (faster start)')).toBeInTheDocument();

    const history = card('History');
    expect(within(history).getByText(/4,312/)).toBeInTheDocument();
    expect(within(history).getByText(/12 since the server started/)).toBeInTheDocument();
    expect(within(history).getByText('off')).toBeInTheDocument();

    const disk = card('Disk');
    expect(within(disk).getByRole('meter', { name: 'Disk space used' })).toHaveAttribute('aria-valuenow', '50');

    expect(within(card('Live sync')).getByText('3 tabs and windows, this one included')).toBeInTheDocument();
    expect(within(card('Backups')).getByText('last backup 6 hours ago')).toBeInTheDocument();
    expect(within(card('Backups')).getByText('4f1c2a9b')).toBeInTheDocument();
    const alerts = card('App alerts');
    expect(within(alerts).getByText('sent to ntfy at https://ntfy.sh')).toBeInTheDocument();
    expect(within(alerts).getByText('GIT_MIRROR_FAILED')).toBeInTheDocument();
  });

  it('lists problems first and links the files kept out of history', async () => {
    const { status, details } = data();
    renderPage(
      { ...status, git: { ...status.git, state: 'failing', lastError: 'disk full', failingSince: hoursAgo(1) } },
      { ...details, backup: { ...details.backup, state: 'failed', failures: '- off-site copy: Fatal: unable to open' } },
    );
    const problems = await screen.findByRole('list', { name: 'Problems' });
    const items = within(problems).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('History is not being saved (for 1 hour): disk full');
    expect(items[1]).toHaveTextContent(/^Backups: the last run failed/);
    expect(within(card('Backups')).getByText('- off-site copy: Fatal: unable to open')).toBeInTheDocument();

    fireEvent.click(within(card('History')).getByRole('button', { name: 'Media/Talk.mp4' }));
    expect(openPath).toHaveBeenCalledWith('Media/Talk.mp4');
  });

  it('offers to commit pending changes and to push to a configured mirror', async () => {
    const { status, details } = data();
    const push = vi.spyOn(api, 'pushMirror').mockResolvedValue({ ...status.mirror, state: 'ready', pushing: true });
    const commit = vi.spyOn(api, 'commitHistory').mockResolvedValue({ commitId: 'abc' });
    registerBuiltins();
    renderPage({ ...status, git: { ...status.git, pendingPaths: 2 }, mirror: { ...status.mirror, state: 'ready', reason: null, remote: 'https://github.com/me/vault.git' } }, details);
    const history = await screen.findByRole('region', { name: 'History' });
    fireEvent.click(within(history).getByRole('button', { name: 'Push to the mirror' }));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    fireEvent.click(within(history).getByRole('button', { name: 'Commit now' }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
  });

  it('sends a test alert and says how it went', async () => {
    const { status, details } = data();
    const send = vi.spyOn(api, 'sendTestAlert').mockResolvedValueOnce({ sent: true, error: null }).mockResolvedValueOnce({ sent: false, error: 'IOException: ntfy answered HTTP 403' });
    renderPage(status, details);
    const alerts = await screen.findByRole('region', { name: 'App alerts' });
    fireEvent.click(within(alerts).getByRole('button', { name: 'Send a test alert' }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.message)).toContain('Test alert sent to ntfy'));
    await waitFor(() => expect(within(alerts).getByRole('button', { name: 'Send a test alert' })).toBeEnabled());
    fireEvent.click(within(alerts).getByRole('button', { name: 'Send a test alert' }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.message)).toContain('The test alert was not sent: IOException: ntfy answered HTTP 403'));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('explains unknown backups and alerts that are off', async () => {
    const { status, details } = data();
    renderPage(status, {
      ...details,
      backup: { state: 'unknown', reason: 'No backup has reported here yet', lastRun: null, lastSuccess: null, snapshot: null, offsite: null, failures: null },
      alerts: { ...details.alerts, state: 'off', reason: 'not configured', server: null, recent: [] },
    });
    expect(await screen.findByText('No backup has reported here yet')).toBeInTheDocument();
    expect(within(card('App alerts')).getByText('off: no ntfy.json')).toBeInTheDocument();
    expect(within(card('App alerts')).getByText('none since the server started')).toBeInTheDocument();
  });

  it('shows the error when the server cannot be reached', async () => {
    vi.spyOn(api, 'getStatus').mockRejectedValue(new Error('Failed to fetch'));
    vi.spyOn(api, 'getStatusDetails').mockRejectedValue(new Error('Failed to fetch'));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <StatusPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
