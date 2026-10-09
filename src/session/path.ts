export type PeerPath = { address: string; family: "IPv4" | "IPv6" };

export class PathMismatchError extends Error {
  override readonly name = "PathMismatchError";
}

export function assertSamePath(first: PeerPath, next: PeerPath): void {
  // TODO: replace this family-only guard with the agreed tailnet path policy.
  if (first.family !== next.family) {
    throw new PathMismatchError(
      `Peer address family changed from ${first.family} to ${next.family}`,
    );
  }
}
