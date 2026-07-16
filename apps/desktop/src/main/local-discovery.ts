export const VOIVOX_DISCOVERY_PORT = 43_817;

export type DiscoveryServerOptions = {
  extensionDiscovery: boolean;
  port: number;
};

export async function startWithExtensionDiscovery<T>(
  start: (options: DiscoveryServerOptions) => Promise<T>
): Promise<{ extensionDiscovery: boolean; server: T }> {
  try {
    return {
      extensionDiscovery: true,
      server: await start({ extensionDiscovery: true, port: VOIVOX_DISCOVERY_PORT })
    };
  } catch (error) {
    if (!isAddressInUse(error)) {
      throw error;
    }
  }

  return {
    extensionDiscovery: false,
    server: await start({ extensionDiscovery: false, port: 0 })
  };
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}
