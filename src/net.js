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
    const hitAction = this.room.makeAction('hit');
    const fragAction = this.room.makeAction('frag');
    const chatAction = this.room.makeAction('chat');
    stateAction.onMessage = (data, meta) => this._emit('state', meta.peerId, data);
    shotAction.onMessage = (data, meta) => this._emit('shot', meta.peerId, data);
    hitAction.onMessage = (data, meta) => this._emit('hit', meta.peerId, data);
    fragAction.onMessage = (data, meta) => this._emit('frag', meta.peerId, data);
    chatAction.onMessage = (data, meta) => this._emit('chat', meta.peerId, data);
    this.sendState = (d) => stateAction.send(d);
    this.sendShot = (d) => shotAction.send(d);
    this.sendHit = (peerId, d) => hitAction.send(d, peerId); // targeted to the victim
    this.sendFrag = (d) => fragAction.send(d);
    this.sendChat = (d) => chatAction.send(d);

    // 0.25 exposes these as setter properties, not methods.
    this.room.onPeerJoin = (id) => { this.peers.add(id); this._emit('count', this.count); };
    this.room.onPeerLeave = (id) => { this.peers.delete(id); this._emit('leave', id); this._emit('count', this.count); };

    this.connected = true;
    this._emit('count', this.count);
    return true;
  }

  broadcastState(data) { if (this.sendState) try { this.sendState(data); } catch { /* not ready */ } }
  broadcastShot(data) { if (this.sendShot) try { this.sendShot(data); } catch { /* not ready */ } }
  sendHitTo(peerId, data) { if (this.sendHit) try { this.sendHit(peerId, data); } catch { /* not ready */ } }
  broadcastFrag(data) { if (this.sendFrag) try { this.sendFrag(data); } catch { /* not ready */ } }

  leave() {
    if (this.room) { try { this.room.leave(); } catch { /* ignore */ } }
    this.room = null;
    this.connected = false;
    this.peers.clear();
  }
}
