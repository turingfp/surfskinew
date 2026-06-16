// Peer-to-peer multiplayer via Trystero (serverless WebRTC; signaling over
// public nostr relays). Players who join the same room name see each other in
// the same session — no game server needed, which suits a static deploy.
//
// Trystero is loaded from a CDN at runtime (multiplayer needs the network
// anyway); single-player works fully offline without ever touching this.

let joinRoomFn = null;

async function getJoinRoom() {
  if (!joinRoomFn) {
    const mod = await import('trystero');
    joinRoomFn = mod.joinRoom;
  }
  return joinRoomFn;
}

export class Net {
  constructor() {
    this.room = null;
    this.sendState = null;
    this.sendShot = null;
    this.connected = false;
    this.peers = new Set();
    this.handlers = {};
  }

  get count() { return this.peers.size + 1; } // peers + self

  on(event, fn) { this.handlers[event] = fn; }
  _emit(event, ...args) { if (this.handlers[event]) this.handlers[event](...args); }

  async join(roomName) {
    const joinRoom = await getJoinRoom();
    this.room = joinRoom({ appId: 'surfski2-cs16' }, roomName || 'public');

    // Trystero 0.25 action API: makeAction returns an object with .send() and
    // a settable .onMessage(payload, { peerId }).
    const stateAction = this.room.makeAction('st');
    const shotAction = this.room.makeAction('shot');
    stateAction.onMessage = (data, meta) => this._emit('state', meta.peerId, data);
    shotAction.onMessage = (data, meta) => this._emit('shot', meta.peerId, data);
    this.sendState = (d) => stateAction.send(d);
    this.sendShot = (d) => shotAction.send(d);

    // 0.25 exposes these as setter properties, not methods.
    this.room.onPeerJoin = (id) => { this.peers.add(id); this._emit('count', this.count); };
    this.room.onPeerLeave = (id) => { this.peers.delete(id); this._emit('leave', id); this._emit('count', this.count); };

    this.connected = true;
    this._emit('count', this.count);
    return true;
  }

  broadcastState(data) { if (this.sendState) try { this.sendState(data); } catch { /* not ready */ } }
  broadcastShot(data) { if (this.sendShot) try { this.sendShot(data); } catch { /* not ready */ } }

  leave() {
    if (this.room) { try { this.room.leave(); } catch { /* ignore */ } }
    this.room = null;
    this.connected = false;
    this.peers.clear();
  }
}
