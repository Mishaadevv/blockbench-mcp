/* =============================================================================
 * Animation tools: animations, bone keyframes and timeline playback.
 *
 * Blockbench stores keyframes on a BoneAnimator attached to an Animation and a
 * node (usually a Group). Channels are rotation / position / scale; each value
 * is a Molang expression string ("0", "math.sin(query.anim_time*180)").
 * ========================================================================== */

function requireAnimations() {
  requireProject();
  if (!Project.animations) Project.animations = [];
  return Project.animations;
}

function resolveAnimation(ref) {
  requireAnimations();
  if (ref === undefined || ref === null || ref === '@selected') {
    if (root.Animation && root.Animation.selected) return root.Animation.selected;
    if (Project.animations.length) return Project.animations[0];
    fail('No animation available.', 'Create one with bb_create_animation.');
  }
  var anim = Project.animations.find(function (a) { return a.uuid === ref || a.name === ref; });
  if (!anim) fail('No animation matching ' + safeStringify(ref) + '.', 'Known: ' + Project.animations.map(function (a) { return a.name; }).join(', '));
  return anim;
}

function selectAnimation(anim) {
  try { if (typeof anim.select === 'function') anim.select(); } catch (err) { if (root.Animation) root.Animation.selected = anim; }
  return anim;
}

tool('bb_list_animations', 'List animations',
  'List the project animations with loop mode, length and per-bone keyframe counts.',
  { type: 'object', properties: {} },
  function () {
    requireAnimations();
    return {
      count: Project.animations.length,
      selected: root.Animation && root.Animation.selected ? root.Animation.selected.name : null,
      animations: Project.animations.map(describeAnimation),
    };
  });

tool('bb_create_animation', 'Create an animation',
  'Create a new animation. loop is "once", "loop" or "hold"; length is in seconds.',
  { type: 'object', properties: { name: { type: 'string' }, loop: { type: 'string', default: 'once' }, length: { type: 'number', default: 1 }, select: { type: 'boolean', default: true } } },
  function (args) {
    requireAnimations();
    var anim = new root.Animation({ name: args.name || 'animation', loop: args.loop || 'once', length: num(args.length || 1) });
    anim.add(true);
    if (args.select !== false) selectAnimation(anim);
    return { animation: describeAnimation(anim) };
  });

tool('bb_set_animation', 'Edit an animation',
  'Change name, loop mode or length of an animation.',
  { type: 'object', properties: { animation: { type: 'string' }, name: { type: 'string' }, loop: { type: 'string' }, length: { type: 'number' } } },
  function (args) {
    var anim = resolveAnimation(args.animation);
    return withUndo({ animations: [anim] }, function () {
      if (args.name !== undefined) anim.name = String(args.name);
      if (args.loop !== undefined) anim.loop = args.loop;
      if (args.length !== undefined) { if (typeof anim.setLength === 'function') anim.setLength(num(args.length)); else anim.length = num(args.length); }
      return { animation: describeAnimation(anim) };
    }, 'MCP edit animation');
  });

tool('bb_delete_animation', 'Delete an animation', 'Remove an animation from the project.',
  { type: 'object', properties: { animation: { type: 'string' } }, required: ['animation'] },
  function (args) {
    var anim = resolveAnimation(args.animation);
    var name = anim.name;
    return withUndo({ animations: [anim] }, function () {
      if (typeof anim.remove === 'function') anim.remove(true); else if (Project.animations) Project.animations.remove(anim);
      return { deleted: name };
    }, 'MCP delete animation');
  });

tool('bb_add_keyframe', 'Add a keyframe',
  'Add a keyframe for a bone on rotation/position/scale. x/y/z are Molang expressions (default "0"), or plain numbers. The bone is referenced by group name or uuid.',
  {
    type: 'object',
    properties: {
      animation: { type: 'string' },
      bone: { type: 'string' },
      channel: { type: 'string', enum: ['rotation', 'position', 'scale'] },
      time: { type: 'number' },
      x: {}, y: {}, z: {},
      interpolation: { type: 'string', default: 'linear' },
    },
    required: ['bone', 'time'],
  },
  function (args) {
    var anim = resolveAnimation(args.animation);
    var node = resolveNode(args.bone);
    var channel = args.channel || 'rotation';
    var animator = anim.getBoneAnimator(node);
    if (!animator) fail('Could not create an animator for "' + node.name + '".');
    if (!animator.channels[channel]) fail('Unknown channel "' + channel + '".', 'Channels: ' + Object.keys(animator.channels).join(', '));
    selectAnimation(anim);
    return withUndo({ animations: [anim] }, function () {
      var kf = animator.addKeyframe({
        channel: channel,
        time: num(args.time),
        interpolation: args.interpolation || 'linear',
        data_points: [{ x: molang(args.x), y: molang(args.y), z: molang(args.z) }],
      });
      return { keyframe: { uuid: kf.uuid, channel: kf.channel, time: kf.time, interpolation: kf.interpolation, values: { x: molang(args.x), y: molang(args.y), z: molang(args.z) } }, animation: anim.name };
    }, 'MCP add keyframe');
  });

function molang(v) { if (v === undefined || v === null) return '0'; if (typeof v === 'number') return String(v); return String(v); }

tool('bb_delete_keyframe', 'Delete a keyframe',
  'Delete a keyframe by uuid, or the one nearest to a given time on a bone/channel.',
  {
    type: 'object',
    properties: { animation: { type: 'string' }, bone: { type: 'string' }, channel: { type: 'string', default: 'rotation' }, time: { type: 'number' }, uuid: { type: 'string' } },
    required: ['bone'],
  },
  function (args) {
    var anim = resolveAnimation(args.animation);
    var node = resolveNode(args.bone);
    var channel = args.channel || 'rotation';
    var animator = anim.animators[node.uuid];
    if (!animator || !animator[channel] || !animator[channel].length) fail('No ' + channel + ' keyframes on "' + node.name + '".');
    return withUndo({ animations: [anim] }, function () {
      var list = animator[channel];
      var index = -1;
      if (args.uuid) index = list.findIndex(function (k) { return k.uuid === args.uuid; });
      else if (args.time !== undefined) {
        var best = Infinity;
        list.forEach(function (k, i) { var d = Math.abs(k.time - args.time); if (d < best) { best = d; index = i; } });
      }
      if (index < 0) fail('No matching keyframe found.');
      var kf = list.splice(index, 1)[0];
      return { deleted: { uuid: kf.uuid, channel: kf.channel, time: kf.time }, animation: anim.name };
    }, 'MCP delete keyframe');
  });

tool('bb_play_animation', 'Timeline playback',
  'Control the animation timeline: set the time, play, pause or stop.',
  { type: 'object', properties: { animation: { type: 'string' }, action: { type: 'string', default: 'set_time' }, time: { type: 'number' } } },
  function (args) {
    var anim = args.animation ? resolveAnimation(args.animation) : null;
    if (anim) selectAnimation(anim);
    var action = args.action || 'set_time';
    var Timeline = root.Timeline;
    if (!Timeline) fail('Timeline is unavailable.');
    if (action === 'set_time' || args.time !== undefined) Timeline.setTime(num(args.time || 0));
    if (action === 'play') { if (typeof Timeline.start === 'function') Timeline.start(); }
    else if (action === 'pause') { if (typeof Timeline.pause === 'function') Timeline.pause(); }
    else if (action === 'stop') { if (typeof Timeline.pause === 'function') Timeline.pause(); if (typeof Timeline.setTime === 'function') Timeline.setTime(0); }
    return { action: action, time: Timeline.time, playing: !!Timeline.playing, animation: anim ? anim.name : null };
  });
