/**
 * @fileoverview SIP Dialog
 */

/**
 * @augments JsSIP
 * @class Class creating a SIP dialog.
 * @param {JsSIP.Session} session
 * @param {JsSIP.IncomingRequest|JsSIP.IncomingResponse} message
 * @param {Enum} type UAC / UAS
 * @param {Enum} state JsSIP.Dialog.C.STATUS_EARLY / JsSIP.Dialog.C.STATUS_CONFIRMED
 */
(function(JsSIP) {
var DialogId, Dialog,
  LOG_PREFIX = JsSIP.name +' | '+ 'DIALOG' +' | ',
  C = {
    // Dialog states
    STATUS_EARLY:       1,
    STATUS_CONFIRMED:   2,

    DEFAULT_MIN_SE: 90
  };

DialogId = function (call_id, local_tag, remote_tag) {
  this.call_id = call_id;
  this.local_tag = local_tag;
  this.remote_tag = remote_tag;
};
DialogId.prototype.toString = function () {
  return this.call_id + this.local_tag + this.remote_tag;
};
DialogId.prototype.toTargetDialogHeader = function () {
  // See RFC 4538
  // Note: the remote/local labels are from the perspective of the recipient
  return this.call_id +
      ';remote-tag=' + this.local_tag +
      ';local-tag=' + this.remote_tag;
};

// RFC 3261 12.1
Dialog = function(owner, message, type, state) {
  var contact;

  if(!message.hasHeader('contact')) {
    console.error(LOG_PREFIX +'unable to create a Dialog without Contact header field');
    return false;
  }

  if(message instanceof JsSIP.IncomingResponse) {
    state = (message.status_code < 200) ? C.STATUS_EARLY : C.STATUS_CONFIRMED;
  } else {
    // Create confirmed dialog if state is not defined
    state = state || C.STATUS_CONFIRMED;
    if (message.method === JsSIP.C.INVITE) {
      this.last_invite_tx = message.server_transaction;
    }
  }

  contact = message.parseHeader('contact');

  // RFC 3261 12.1.1
  if(type === 'UAS') {
    this.id = new DialogId(message.call_id, message.to_tag, message.from_tag);
    this.state = state;
    this.remote_seqnum = message.cseq;
    this.local_uri = message.parseHeader('to').uri;
    this.remote_uri = message.parseHeader('from').uri;
    this.remote_target = contact.uri;
    this.route_set = message.getHeaderAll('record-route');
  }
  // RFC 3261 12.1.2
  else if(type === 'UAC') {
    this.id = new DialogId(message.call_id, message.from_tag, message.to_tag);
    this.state = state;
    this.local_seqnum = message.cseq;
    this.local_uri = message.parseHeader('from').uri;
    this.remote_uri = message.parseHeader('to').uri;
    this.remote_target = contact.uri;
    this.route_set = message.getHeaderAll('record-route').reverse();
  }

  // Session timer state (RFC 4028)
  this.session_timer = {
      localRefresher: true,
      interval: null,
      min_interval: C.DEFAULT_MIN_SE,
      timer_id: null
  };

  this.owner = owner;
  owner.ua.dialogs[this.id.toString()] = this;
  console.log(LOG_PREFIX +'new ' + type + ' dialog created with status ' + (this.state === C.STATUS_EARLY ? 'EARLY': 'CONFIRMED'));
};

Dialog.prototype = {
  /**
   * @param {JsSIP.IncomingMessage} message
   * @param {Enum} UAC/UAS
   */
  update: function(message, type) {
    this.state = C.STATUS_CONFIRMED;

    console.log(LOG_PREFIX +'dialog '+ this.id.toString() +'  changed to CONFIRMED state');

    if(type === 'UAC') {
      // RFC 3261 13.2.2.4
      this.route_set = message.getHeaderAll('record-route').reverse();
    }
  },

  isConfirmed: function() {
    return this.state === C.STATUS_CONFIRMED;
  },

  terminate: function() {
    console.log(LOG_PREFIX +'dialog ' + this.id.toString() + ' deleted');
    this.clearSessionRefreshTimer();
    delete this.owner.ua.dialogs[this.id.toString()];
  },

  /**
  * @param {String} method request method
  * @param {Object} extraHeaders extra headers
  * @returns {JsSIP.OutgoingRequest}
  */

  // RFC 3261 12.2.1.1
  createRequest: function(method, extraHeaders) {
    var cseq, request;
    extraHeaders = extraHeaders || [];

    if(!this.local_seqnum) { this.local_seqnum = Math.floor(Math.random() * 10000); }

    cseq = (method === JsSIP.C.CANCEL || method === JsSIP.C.ACK) ? this.local_seqnum : this.local_seqnum += 1;

    // Add Session Timer headers (RFC 4028)
    if (method === JsSIP.C.INVITE || method === JsSIP.C.UPDATE) {
      var min_se = this.session_timer.min_interval;
      var interval = this.session_timer.interval;

      if (min_se > C.DEFAULT_MIN_SE) {
        extraHeaders.push('Min-SE: ' + min_se);
      }

      if (interval !== null) {
        var expires = min_se > interval ? min_se : interval;
        var refresher = this.session_timer.localRefresher ? 'uac' : 'uas';
        extraHeaders.push('Session-Expires: ' + expires + ';refresher=' + refresher);
      }
    }

    request = new JsSIP.OutgoingRequest(
      method,
      this.remote_target,
      this.owner.ua, {
        'cseq': cseq,
        'call_id': this.id.call_id,
        'from_uri': this.local_uri,
        'from_tag': this.id.local_tag,
        'to_uri': this.remote_uri,
        'to_tag': this.id.remote_tag,
        'route_set': this.route_set,
        'extra_supported': JsSIP.Utils.getSessionExtensions(this.owner, method)
      }, extraHeaders);

    request.dialog = this;

    return request;
  },

  /**
  * @param {JsSIP.IncomingRequest} request
  * @returns {Boolean}
  */

  // RFC 3261 12.2.2
  checkInDialogRequest: function(request) {
    var retryAfter;

    if(!this.remote_seqnum) {
      this.remote_seqnum = request.cseq;
    } else if(request.cseq < this.remote_seqnum) {
        //Do not try to reply to an ACK request.
        if (request.method !== JsSIP.C.ACK) {
          request.reply(500);
        }
        return false;
    } else if(request.cseq > this.remote_seqnum) {
      this.remote_seqnum = request.cseq;
    }

    switch(request.method) {
      case JsSIP.C.INVITE:
        // RFC3261 14.2 Modifying an Existing Session -UAS BEHAVIOR-
        if(this.last_invite_tx &&
            this.last_invite_tx.state === JsSIP.Transactions.C.STATUS_PROCEEDING) {
          retryAfter = (Math.random() * 10 | 0) + 1;
          request.reply(500, null, ['Retry-After:'+ retryAfter]);
          return false;
        }
        // Cache the transaction to check next time
        this.last_invite_tx = request.server_transaction;
        break;
      case JsSIP.C.UPDATE:
        // RFC3311 5.2
        if(this.last_update_tx) {
          switch(this.last_update_tx.state) {
          case JsSIP.Transactions.C.STATUS_TRYING:
          case JsSIP.Transactions.C.STATUS_PROCEEDING:
            // We have not yet responded to the previous UPDATE
            retryAfter = (Math.random() * 10 | 0) + 1;
            request.reply(500, null, ['Retry-After:'+ retryAfter]);
            return false;
          default:
            break;
          }
        }
        // Cache this UPDATE transaction to check next time
        this.last_update_tx = request.server_transaction;
        break;
    }

    return true;
  },

  /**
  * @param {JsSIP.IncomingRequest} request
  */
  receiveRequest: function(request) {
    //Check in-dialog request
    if(!this.checkInDialogRequest(request)) {
      return;
    }

    if(!this.owner.receiveRequest(request)) {
      return;
    }

    // The request was accepted, so now check for target refresh
    switch(request.method) {
      case JsSIP.C.INVITE:    // RFC3261 12.2.2
      case JsSIP.C.UPDATE:    // RFC3311 5.2
      case JsSIP.C.NOTIFY:    // RFC6655 3.2
        if(request.hasHeader('contact')) {
          this.remote_target = request.parseHeader('contact').uri;
        }
        break;
    }
  },

  updateMinSessionExpires: function (interval) {
    if (interval > this.session_timer.min_interval) {
      this.session_timer.min_interval = interval;
    }
  },

  /**
   * Configures the appropriate session timer timeout and behaviour, based
   * on the provided session expires interval and whether the local endpoint
   * is responsible for refreshes.
   * @param {Number} interval The session expires interval (in seconds).
   * @param {Boolean} localRefresher
   */
  setSessionRefreshTimer: function () {
    var localRefresher = this.session_timer.localRefresher;
    var interval = this.session_timer.interval;
    var timeout;
    var action;
    var self = this;

    if (localRefresher) {
      timeout = interval / 2;
      action = function () {
        self.session_timer.timer_id = null;
        self.owner.emit('refresh', self.owner, {});
      };
    } else {
      timeout = interval - Math.max(interval / 3, 32);
      action = function () {
        self.session_timer.timer_id = null;
        self.owner.sendBye({
          status_code: 408,
          reason_phrase: JsSIP.C.causes.SESSION_TIMER
        });
        self.owner.ended('system', null, JsSIP.C.causes.SESSION_TIMER);
      };
    }

    this.session_timer.timer_id = window.setTimeout(action, timeout * 1000);
  },

  clearSessionRefreshTimer: function () {
    if (this.session_timer.timer_id !== null) {
      window.clearTimeout(this.session_timer.timer_id);
      this.session_timer.timer_id = null;
    }
  },

  disableSessionRefresh: function () {
    this.session_timer.interval = null;
    this.clearSessionRefreshTimer();
  },

  /**
   * Should only be called when we receive, or are about to send, a 2xx response
   * to a method that acts as a session refresher (currently INVITE and UPDATE).
   * @param message The received message (may be request or response)
   */
  processSessionTimerHeaders: function (message) {
    if (message.hasHeader('min-se')) {
      this.updateMinSessionExpires(message.parseHeader('min-se'));
    }

    if (!message.hasHeader('session-expires')) {
      this.disableSessionRefresh();
      return;
    }

    this.clearSessionRefreshTimer();

    var se = message.parseHeader('session-expires');
    var localRefresher = true;

    if (message instanceof JsSIP.IncomingRequest) {
      // Session timer requested
      // Refresher parameter is optional at this stage
      if (se.params && se.params.refresher) {
        localRefresher = se.params.refresher === 'uas';
      }
    } else if (message instanceof JsSIP.IncomingResponse) {
      // Session timer enabled
      // Refresher parameter is required at this stage
      localRefresher = se.params.refresher === 'uac';
    } else {
      throw new TypeError('Unexpected message type');
    }

    this.session_timer.interval = se.interval;
    this.session_timer.localRefresher = localRefresher;

    this.setSessionRefreshTimer();
  },

  /**
   * Adds the Session-Expires header to the provided extra headers array.
   * Should only be used for a 2xx response to a method that acts as a session
   * refresher (currently INVITE and UPDATE).
   * @param extraHeaders
   */
  addSessionTimerResponseHeaders: function (extraHeaders) {
    var interval = this.session_timer.interval;
    if (interval) {
      var refresher = this.session_timer.localRefresher ? 'uas' : 'uac';
      extraHeaders.push('Session-Expires: ' + interval + ';refresher=' + refresher);
    }
  }
};

Dialog.C = C;
JsSIP.DialogId = DialogId;
JsSIP.Dialog = Dialog;
}(JsSIP));
