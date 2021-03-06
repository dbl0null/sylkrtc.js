'use strict';

import debug from 'debug';
import uuidv4 from 'uuid/v4';
import utils from './utils';

import { EventEmitter } from 'events';

const DEBUG = debug('sylkrtc:Call');


class Call extends EventEmitter {
    constructor(account) {
        super();
        this._account = account;
        this._id = null;
        this._direction = null;
        this._pc = null;
        this._state = null;
        this._terminated = false;
        this._incomingSdp = null;
        this._localIdentity = new utils.Identity(account.id, account.displayName);
        this._remoteIdentity = null;
        this._dtmfSender = null;
        this._delay_established = false;  // set to true when we need to delay posting the state change to 'established'
        this._setup_in_progress = false;  // set while we set the remote description and setup the peer copnnection

        // bind some handlers to this instance
        this._onDtmf = this._onDtmf.bind(this);
    }

    get account() {
        return this._account;
    }

    get id() {
        return this._id;
    }

    get direction() {
        return this._direction;
    }

    get state() {
        return this._state;
    }

    get localIdentity() {
        return this._localIdentity;
    }

    get remoteIdentity() {
        return this._remoteIdentity;
    }

    getLocalStreams() {
        if (this._pc !== null) {
            return this._pc.getLocalStreams();
        } else {
            return [];
        }
    }

    getRemoteStreams() {
        if (this._pc !== null) {
            return this._pc.getRemoteStreams();
        } else {
            return [];
        }
    }

    answer(options = {}) {
        if (this._state !== 'incoming') {
            throw new Error('Call is not in the incoming state: ' + this._state);
        }

        if (!options.localStream) {
            throw new Error('Missing localStream');
        }

        const pcConfig = options.pcConfig || {iceServers:[]};
        const answerOptions = options.answerOptions;

        // Create the RTCPeerConnection
        this._initRTCPeerConnection(pcConfig);

        this._pc.addStream(options.localStream);
        this.emit('localStreamAdded', options.localStream);
        this._pc.setRemoteDescription(
            new RTCSessionDescription({type: 'offer', sdp: this._incomingSdp}),
            // success
            () => {
                utils.createLocalSdp(this._pc, 'answer', answerOptions)
                    .then((sdp) => {
                        DEBUG('Local SDP: %s', sdp);
                        this._sendAnswer(sdp);
                    })
                    .catch((reason) => {
                        DEBUG(reason);
                        this.terminate();
                    });
            },
            // failure
            (error) => {
                DEBUG('Error setting remote description: %s', error);
                this.terminate();
            }
        );
    }

    terminate() {
        if (this._terminated) {
            return;
        }
        DEBUG('Terminating call');
        this._sendTerminate();
    }

    sendDtmf(tones, duration=100, interToneGap=70) {
        DEBUG('sendDtmf()');
        if (this._dtmfSender === null) {
            if (this._pc !== null) {
                let track = null;
                try {
                    track = this._pc.getLocalStreams()[0].getAudioTracks()[0];
                } catch (e) {
                    // ignore
                }
                if (track !== null) {
                    DEBUG('Creating DTMF sender');
                    this._dtmfSender = this._pc.createDTMFSender(track);
                    if (this._dtmfSender) {
                        this._dtmfSender.addEventListener('tonechange', this._onDtmf);
                    }
                }
            }
        }
        if (this._dtmfSender) {
            DEBUG('Sending DTMF tones');
            this._dtmfSender.insertDTMF(tones, duration, interToneGap);
        }
    }

    // Private API

    _initOutgoing(uri, options={}) {
        if (uri.indexOf('@') === -1) {
            throw new Error('Invalid URI');
        }

        if (!options.localStream) {
            throw new Error('Missing localStream');
        }

        this._id = uuidv4();
        this._direction = 'outgoing';
        this._remoteIdentity = new utils.Identity(uri);

        const pcConfig = options.pcConfig || {iceServers:[]};
        const offerOptions = options.offerOptions;

        // Create the RTCPeerConnection
        this._initRTCPeerConnection(pcConfig);

        this._pc.addStream(options.localStream);
        this.emit('localStreamAdded', options.localStream);
        utils.createLocalSdp(this._pc, 'offer', offerOptions)
            .then((sdp) => {
                DEBUG('Local SDP: %s', sdp);
                this._sendCall(uri, sdp);
            })
            .catch((reason) => {
                DEBUG(reason);
                this._localTerminate(reason);
            });
    }

    _initIncoming(id, caller, sdp) {
        this._id = id;
        this._remoteIdentity = new utils.Identity(caller.uri, caller.display_name);
        this._incomingSdp = sdp;
        this._direction = 'incoming';
        this._state = 'incoming';
        DEBUG('Remote SDP: %s', sdp);
    }

    _handleEvent(message) {
        DEBUG('Call event: %o', message);
        switch (message.event) {
            case 'state':
                let oldState = this._state;
                let newState = message.state;
                this._state = newState;

                if (newState === 'accepted' && this._direction === 'outgoing') {
                    DEBUG('Call accepted');
                    this.emit('stateChanged', oldState, newState, {});
                    const sdp = utils.mungeSdp(message.sdp);
                    DEBUG('Remote SDP: %s', sdp);
                    this._setup_in_progress = true;
                    this._pc.setRemoteDescription(
                        new RTCSessionDescription({type: 'answer', sdp: sdp}),
                        // success
                        () => {
                            this._setup_in_progress = false;
                            if (!this._terminated) {
                                if (this._delay_established) {
                                    oldState = this._state;
                                    this._state = 'established';
                                    DEBUG('Setting delayed established state!');
                                    this.emit('stateChanged', oldState, this._state, {});
                                    this._delay_established = false;
                                }
                            }
                        },
                        // failure
                        (error) => {
                            DEBUG('Error accepting call: %s', error);
                            this.terminate();
                        }
                    );
                } else if (newState === 'established' && this._direction === 'outgoing') {
                    if (this._setup_in_progress) {
                        this._delay_established = true;
                    } else {
                        this.emit('stateChanged', oldState, newState, {});
                    }
                } else if (newState === 'terminated') {
                    this.emit('stateChanged', oldState, newState, {reason: message.reason});
                    this._terminated = true;
                    this._account._calls.delete(this.id);
                    this._closeRTCPeerConnection();
                } else {
                    this.emit('stateChanged', oldState, newState, {});
                }
                break;
            default:
                break;
        }
    }

    _initRTCPeerConnection(pcConfig) {
        if (this._pc !== null) {
            throw new Error('RTCPeerConnection already initialized');
        }

        this._pc = new RTCPeerConnection(pcConfig);
        this._pc.addEventListener('addstream', (event) => {
            DEBUG('Stream added');
            this.emit('streamAdded', event.stream);
        });
        this._pc.addEventListener('icecandidate', (event) => {
            if (event.candidate !== null) {
                DEBUG('New ICE candidate %o', event.candidate);
            } else {
                DEBUG('ICE candidate gathering finished');
            }
            this._sendTrickle(event.candidate);
        });
    }

    _sendRequest(req, cb) {
        this._account._sendRequest(req, cb);
    }

    _sendCall(uri, sdp) {
        const req = {
            sylkrtc: 'session-create',
            account: this.account.id,
            session: this.id,
            uri: uri,
            sdp: sdp
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Call error: %s', error);
                this._localTerminate(error);
            }
        });
    }

    _sendTerminate() {
        const req = {
            sylkrtc: 'session-terminate',
            session: this.id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error terminating call: %s', error);
                this._localTerminate(error);
            }
        });
        setTimeout(() => {
            if (!this._terminated) {
                DEBUG('Timeout terminating call');
                this._localTerminate('200 OK');
            }
            this._terminated = true;
        }, 150);
    }

    _sendTrickle(candidate) {
        const req = {
            sylkrtc: 'session-trickle',
            session: this.id,
            candidates: candidate !== null ? [candidate] : [],
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Trickle error: %s', error);
                this._localTerminate(error);
            }
        });
    }

    _sendAnswer(sdp) {
        const req = {
            sylkrtc: 'session-answer',
            session: this.id,
            sdp: sdp
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Answer error: %s', error);
                this.terminate();
            }
        });
    }

    _closeRTCPeerConnection() {
        DEBUG('Closing RTCPeerConnection');
        if (this._pc !== null) {
            for (let stream of this._pc.getLocalStreams()) {
                utils.closeMediaStream(stream);
            }
            for (let stream of this._pc.getRemoteStreams()) {
                utils.closeMediaStream(stream);
            }
            this._pc.close();
            this._pc = null;
            if (this._dtmfSender !== null) {
                this._dtmfSender.removeEventListener('tonechange', this._onDtmf);
                this._dtmfSender = null;
            }
        }
    }

    _localTerminate(error) {
        if (this._terminated) {
            return;
        }
        DEBUG('Local terminate');
        this._account._calls.delete(this.id);
        this._terminated = true;
        const oldState = this._state;
        const newState = 'terminated';
        const data = {
            reason: error.toString()
        };
        this._closeRTCPeerConnection();
        this.emit('stateChanged', oldState, newState, data);
    }

    _onDtmf(event) {
        DEBUG('Sent DTMF tone %s', event.tone);
        this.emit('dtmfToneSent', event.tone);
    }
}


export { Call };
