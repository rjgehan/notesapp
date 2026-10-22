// The properties endpoints (API.md §38, ROADMAP item 13): every property of the vault, a
// property's values, the vault's property types, and renaming a property in every note.
import { useQuery } from '@tanstack/react-query';
import { apiFetch, query } from '../api/client';
import { queryClient } from '../api/queryClient';
import type {
  PropertiesResponse,
  PropertyRenameRequest,
  PropertyRenameResult,
  PropertyType,
  PropertyTypesResponse,
  PropertyValuesResponse,
} from '../api/types';

export const propertiesApi = {
  list: () => apiFetch<PropertiesResponse>('/api/properties'),
  values: (name: string) => apiFetch<PropertyValuesResponse>('/api/properties/values' + query({ name })),
  types: () => apiFetch<PropertyTypesResponse>('/api/properties/types'),
  setType: (name: string, type: PropertyType | null) => apiFetch<PropertyTypesResponse>('/api/properties/types', { method: 'PUT', json: { name, type } }),
  rename: (req: PropertyRenameRequest) => apiFetch<PropertyRenameResult>('/api/properties/rename', { method: 'POST', json: req }),
};

export const propertyKeys = {
  all: ['properties'] as const,
  list: () => ['properties', 'list'] as const,
  values: (name: string) => ['properties', 'values', name.toLowerCase()] as const,
  types: () => ['properties', 'types'] as const,
};

/** Every property of the vault, refreshed (debounced) as notes change. */
export function useVaultProperties(enabled = true) {
  return useQuery({ queryKey: propertyKeys.list(), queryFn: propertiesApi.list, staleTime: 30_000, enabled });
}

/** The vault's property types, kept current by `types.changed`. */
export function usePropertyTypes() {
  return useQuery({ queryKey: propertyKeys.types(), queryFn: propertiesApi.types, staleTime: Infinity });
}

/** A property's values across the vault, for suggestions (fetched when a field wants them). */
export function usePropertyValues(name: string, enabled: boolean) {
  return useQuery({ queryKey: propertyKeys.values(name), queryFn: () => propertiesApi.values(name), staleTime: 30_000, enabled });
}

/** Sets a property's type (null removes it); the cache shows it at once. */
export async function setPropertyType(name: string, type: PropertyType | null): Promise<void> {
  const result = await propertiesApi.setType(name, type);
  queryClient.setQueryData(propertyKeys.types(), result);
  void queryClient.invalidateQueries({ queryKey: propertyKeys.list() });
}

let ownEditTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * This tab changed a note's properties: its own saves are not echoed back as events (API.md
 * §16.4), so the list and values are refetched once the autosave has had time to run.
 */
export function refreshAfterOwnEdit(delayMs = 3000): void {
  if (ownEditTimer !== null) clearTimeout(ownEditTimer);
  ownEditTimer = setTimeout(() => {
    ownEditTimer = null;
    void queryClient.invalidateQueries({ queryKey: propertyKeys.list() });
    void queryClient.invalidateQueries({ queryKey: ['properties', 'values'] });
  }, delayMs);
}
