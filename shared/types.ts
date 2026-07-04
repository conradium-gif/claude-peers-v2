// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  name: string;
  host: string; // friendly machine label ("desktop") — display/addressing only
  machine_id: string; // stable machine UUID — the real identity key
  pid: number;
  claude_pid: number | null;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
  pending?: number; // queued messages waiting for this peer
}

export type MessageStatus = "queued" | "delivered" | "expired";

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  status: MessageStatus;
  delivered_at: string | null;
}

export interface DeliveredMessage extends Message {
  from_name: string;
  from_cwd: string;
  from_summary: string;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  claude_pid: number | null;
  host?: string; // machine label; broker defaults to its own host if absent
  machine_id?: string; // stable machine UUID (absent from pre-0.3.1 clients)
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
  name: string;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to: string; // peer id OR peer name
  text: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  message_id?: number;
  to_id?: PeerId;
  to_name?: string;
  target_last_seen?: string;
}

export interface ConsumeRequest {
  peer_id: PeerId;
}

export interface ConsumeResponse {
  messages: DeliveredMessage[];
}

export interface FindPeerRequest {
  claude_pids: number[];
  host?: string; // legacy fallback match for pre-machine-id registrations
  machine_id?: string; // primary scoping key: PIDs collide across machines
}

export interface MessageStatusRequest {
  message_id: number;
}

export interface MessageStatusResponse {
  found: boolean;
  status?: MessageStatus;
  sent_at?: string;
  delivered_at?: string | null;
  to_id?: PeerId;
  to_name?: string;
}
