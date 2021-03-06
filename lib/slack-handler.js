'use strict';

var _ = require('lodash');

var HELPERS = {
  getIrcChannelName: function getIrcChannelName(context, slackChannel) {
    var channelConfig = {};
    try {
      if (slackChannel.purpose && slackChannel.purpose.value) {
        channelConfig = HELPERS.parseConfig(slackChannel.purpose.value) || {};
      }
    } catch(e) {
      context.logger.warn('Failed to parse channel config: %s', e);
    }
    return channelConfig.channelName || ('#' + slackChannel.name);
  },
  parseConfig: function parseConfig(configString) {
    configString = configString || '{}';
    configString = configString.replace(/[\u201C-\u201D]/g, '"');
    if (configString.match(/["{:]/)) {
      // Looks like JSON
      return JSON.parse(configString);
    } else {
      // Something else
      return null;
    }
  },
  parseURLs: function parseURLs(msg) {
    var newMsg = msg;
    var slackUrlRegex = /<[^>]*\|?[^>]*>/g;
    var urlRegex = /(http(s)?:\/\/.)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/g;

    if (msg.match(slackUrlRegex)) {
      msg.match(slackUrlRegex).forEach(function(url) {
        if (url.match(urlRegex)) {
          newMsg = newMsg.replace(url, url.match(urlRegex)[0])
        }
      });
    }
    
    return newMsg;
  },
  parseEscapes: function parseEscapes(msg) {
    var newMsg = msg.replace('&amp;', '&');
    newMsg = newMsg.replace('&lt;', '<');
    newMsg = newMsg.replace('&gt;', '>');

    return newMsg;
  }
};

// Slack events documented at https://api.slack.com/rtm#events
var SLACK_EVENTS = {
  open: function started(context) {
    var team = context.slack.client.data.getTeamById(context.slack.client.rtm.activeTeamId);
    context.logger.info('Slack: Connected to Slack team "%s"', team.name);

    // Prepare IRC connection
    var user = context.slack.client.data.getUserById(context.slack.client.rtm.activeUserId);
    var userConfig;
    try {
      userConfig = HELPERS.parseConfig(user.profile.title) || {};
    } catch(e) {
      context.logger.warn('Failed to parse user config: %s', e);
      userConfig = {};
    }
    // TODO: Fetch channel config from channel purpose
    var userChannels = _.chain(context.slack.client.data.channels)
                    .filter('is_member')
                    .map(HELPERS.getIrcChannelName.bind(null, context))
                    .valueOf()
                    .filter((chan) => (chan !== '#general' && (chan !== '#random')));

    context.irc.options = {
      server: userConfig.server,
      port: userConfig.port || 6667,
      nick: user.name,
      realName: user.realName,
      channels: userChannels
    };

    context.irc.options = _.assign(context.irc.options, userConfig);
    context.irc.listener.init(context);

    // TODO: Sync channels on reconnect
  },
  message: function message(context, message) {
    if (message.subtype === 'bot_message') {
      // Sent from self, skipping
      return;
    }

    if (message.text) {
      message.text = HELPERS.parseURLs(message.text)
      message.text = HELPERS.parseEscapes(message.text)
    }

    var channel = context.slack.client.data.getChannelById(message.channel);
    var group = context.slack.client.data.getGroupById(message.channel);

    var target;
    if (channel) {
      target = HELPERS.getIrcChannelName(context, channel);
    } else if (group) {
      target = group.name;
    } else {
      context.logger.error('Slack: Target not found for %s', message.channel);
      return;
    }

    if (!message.subtype) {
      context.logger.verbose('Slack: New channel message in %s: "%s"', target, message.text);
      context.irc.client.say(target, message.text);
    } else if (message.subtype === 'me_message') {
      context.logger.verbose('Slack: New action message in %s: "%s"', target, message.text);
      context.irc.client.action(target, message.text);
    } else if (message.subtype === 'channel_topic') {
      context.logger.verbose('Slack: Topic updated in %s to "%s"', target, message.topic);
      var ircChannel = context.irc.client.chans[target];
      if (ircChannel && ircChannel.topic !== HELPERS.parseURLs(message.topic)) {
        context.irc.client.send('TOPIC', target, HELPERS.parseURLs(message.topic));
      }
    } else if (message.subtype === 'file_share') {
      // TODO: Support file sharing
      context.logger.warn('Slack: File sharing not yet supported');
    } else {
      // Skip rest of message types
      context.logger.verbose('Slack: No handler for message type %s', message.subtype);
      return;
    }
  },
  channel_joined: function channelJoined(context, message) {
    // message.channel is object
    // TODO: Figure out how to get the channel purpose on channel creation
    var channelName = HELPERS.getIrcChannelName(context, message.channel);
    context.logger.verbose('Slack: Joining channel %s', channelName);
    context.irc.client.join(channelName);
  },
  channel_left: function channelLeft(context, message) {
    // message.channel is ID
    var channel = context.slack.client.data.getChannelById(message.channel);
    var channelName = HELPERS.getIrcChannelName(context, channel);
    context.logger.verbose('Slack: Leaving channel %s', channelName);
    context.irc.client.part(channelName);
  },
  dnd_updated: function dndUpdated(context, message) {
    if (message.dnd_status.dnd_enabled) {
      context.logger.verbose('Slack: DnD status set');
      context.irc.client.send('AWAY', 'Do-not-distrub');
    } else {
      context.logger.verbose('Slack: DnD status removed');
      context.irc.client.send('AWAY');
    }
  },
  manual_presence_change: function manualPresenceChange(context, message) {
    context.logger.verbose('Slack: Presence status %s', message.presence);
    if (message.presence === 'active') {
      context.irc.client.send('AWAY');
    } else {
      context.irc.client.send('AWAY', message.presence);
    }
  },
  pref_change: function prefChange(context, message) {
    // TODO: Update irc options like name and such
  }
};

module.exports = {
  init: function initSlackHandler(context) {
    context.logger.verbose('Binding Slack event handler');
    if (!context.slack.events) {
      context.logger.error('Cannot bind Slack event handler before Slack event listener');
      return;
    }

    _.forEach(SLACK_EVENTS, function(handler, eventName) {
      var boundHandler = handler.bind(null, context);
      handler._boundListener = function() {
        try {
          boundHandler.apply(null, arguments);
        } catch(error) {
          context.logger.error('Failed to handle Slack event %s.', eventName, error);
        }
      };
      context.slack.events.addListener(eventName, handler._boundListener);
    });
  },
  reload: function reloadSlackHandler(context) {
    context.logger.info('Reloading Slack event handler');

    context.slack.handler.close(context);
    context.slack.handler = module.exports;
    context.slack.handler.init(context);
  },
  close: function closeSlackHandler(context) {
    context.logger.verbose('Unbinding Slack event handler.');

    if (context.slack.events) {
      _.forEach(SLACK_EVENTS, function(handler, eventName) {
        context.slack.events.removeListener(eventName, handler._boundListener);
      });
    }
  }
};
