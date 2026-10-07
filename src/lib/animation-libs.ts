// The parts of the two animation libraries the shell calls, in a module of
// their own: lib/motion.ts imports it on demand, so it becomes a separate
// chunk fetched after the screen is up, and naming the functions here lets
// the bundler leave the rest of each library out of that chunk.
export { animate as motionAnimate } from "motion";
export { animate as animeAnimate, stagger as animeStagger, svg as animeSvg } from "animejs";
