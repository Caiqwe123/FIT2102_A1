/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html, animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

import { subscribe } from "diagnostics_channel";
import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    map,
    scan,
    switchMap,
    take,
    merge,
    startWith,
    ReplaySubject,
    of,
} from "rxjs";
import { fromFetch } from "rxjs/fetch";
import { ppid, prependListener } from "process";

/** Constants */

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
    DARK: "#9A9A9A", //rgb(154,154,154) from style.CSS
    LIGHT: "#F1F1F1",
} as const;

const Birb = {
    WIDTH: 42,
    HEIGHT: 30,
} as const;

const Constants = {
    PIPE_WIDTH: 50,
    TICK_RATE_MS: 50, // Might need to change this!
    GRAVITY: 1, // Gravity constant
    GROUND: 400, // Ground level
    CEILING: 0, // Ceiling level
    SEED: 1234, // Random seed
    JUMP_SPEED: -5, // bird's jumping speed when space is pressed
    PIPE_SPEED: 8, // pipe moving speed
    BIRD_X: Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2, // bird's fixed x-coordinate
} as const;

abstract class RNG {
    private static m = 0x80000000; // 2^31
    private static a = 1103515245;
    private static c = 12345;

    public static hash = (seed: number): number =>
        (RNG.a * seed + RNG.c) % RNG.m;

    public static scale = (hash: number): number =>
        (2 * hash) / (RNG.m - 1) - 1; // in [-1, 1]
}

// User input
type Key = "Space";

// Represents a pipe obstacle in the game
type Pipe = Readonly<{
    gapY: number; // Vertical position of the gap (normalized 0-1)
    gapHeight: number; // Height of the gap (normalized 0-1)
    delay: number; // Spawn delay in seconds
    x: number; // Current horizontal position of pipe
    passed: boolean; // Whether this pipe has passed through by the bird
    special: boolean; // Whether this pipe gives double points
}>;

// Axis-aligned bounding box for collision detection
type Box = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

// Ghost bird
type Ghost = Readonly<{
    time: number; // timestamp
    y: number; // position
    run: number; // the number of run
}>;

// State processing
type State = Readonly<{
    gameEnd: boolean; // game end flag
    gameStart: boolean; // game start flag
    gamePause: boolean; // game pause flag
    position: number; // y-coordinate of the bird
    velocity: number; // vertical velocity of the bird
    lives: number; // number of remaining lives
    seed: number; // random seed
    score: number; // current score
    resume: boolean; // resume flag, preventing reducing lives continuouly when flying through a pipe
    fullScore: number; // total score that can be obtained
    pipes: Pipe[]; // array of pipes
    time: number; // time stamp (millisecond)
    starx: number; // x-coordinate of star
    stary: number; // y-coordinate of star
    skullx: number; // x-coordinate of skull
    skully: number; // y-coordinate of skull
    ghosts: ReplaySubject<Ghost>; // stores ghost bird information
    run: number; // current number of runs
}>;

const initialState: State = {
    gameEnd: false,
    gameStart: false,
    gamePause: false,
    position: Constants.GROUND / 2, // begins with bird being at center vertically
    velocity: 0, // initial velocity is 0
    lives: 3, // start with 3 lives
    score: 0, // initial score: 0
    seed: Constants.SEED,
    resume: false,
    fullScore: 0,
    pipes: [], // start with empty array
    time: 0,
    starx: -100, // star invisible initially
    stary: -100, // star invisible initially
    skullx: -100, // skull invisible initially
    skully: -100, //skull invisible initially
    ghosts: new ReplaySubject<Ghost>(), // no ghost birds at the start of a new game
    run: 1, // start with first run
};

/**
 * Creates an axis-aligned bounding box
 * @param x - X-coordinate of top-left corner
 * @param y - Y-coordinate of top-left corner
 * @param width - Box width
 * @param height - Box height
 * @returns Box object
 */
const createBox = (
    x: number,
    y: number,
    width: number,
    height: number,
): Box => {
    return {
        x: x,
        y: y,
        width: width,
        height: height,
    };
};

/**
 * Checks for collision between two axis-aligned bounding boxes
 * @param box1 - First box
 * @param box2 - Second box
 * @returns True if boxes overlap
 */
const isOverlap = (box1: Box, box2: Box): boolean => {
    const box1Right = box1.x + box1.width;
    const box1Bottom = box1.y + box1.height;
    const box2Right = box2.x + box2.width;
    const box2Bottom = box2.y + box2.height;

    const result =
        box1.x > box2Right ||
        box1Right < box2.x ||
        box1.y > box2Bottom ||
        box1Bottom < box2.y;

    return !result;
};

/**
 * Generates a random number within specified range using seed
 * @param min - Minimum value
 * @param max - Maximum value
 * @param seed - Current RNG seed
 * @returns Random value in [min, max] range
 */
const generateRandom = (min: number, max: number, seed: number): number => {
    return (
        (RNG.scale(RNG.hash(seed)) / 2) * (max - min) + min + (max - min) / 2
    );
};

/**
 * Main game loop update function
 * Processes one frame of game state updates including:
 * - Bird physics
 * - Collision detection
 * - State transitions
 * - Pipe and power-up logic
 * @param s - Current game state
 * @returns Updated game state
 */
const tick = (s: State) => {
    // Start game if game not started
    if (!s.gameStart) return { ...s, gameStart: true };

    // Game win when full score is got and no remaining pipes
    if (s.gameStart && s.score >= s.fullScore && s.pipes.length == 0)
        return { ...s, gameEnd: true };

    // Stop refreshing current state when game pauses or finishes
    if (s.gamePause || s.gameEnd) return s;

    // if the bird is dead, game is over
    if (s.lives <= 0) return { ...s, gameEnd: true };

    // update bird position
    const newPosition = s.position + s.velocity;
    // update velocity
    const newVelocity = s.velocity + Constants.GRAVITY;
    // update seed
    const newSeed = RNG.hash(s.seed);
    // update timestamp
    const newTime = s.time + Constants.TICK_RATE_MS;

    // Normal flying state
    const normal = {
        ...s,
        position: newPosition,
        velocity: newVelocity,
        seed: newSeed,
        time: newTime,
        resume: false,
    };

    // Predefined collision states
    const hit_bottom_state = {
        ...s,
        lives: s.lives - 1,
        seed: newSeed,
        resume: true,
        velocity: generateRandom(-10, -3, s.seed),
        time: newTime,
    };

    const hit_top_state = {
        ...s,
        lives: s.lives - 1,
        seed: newSeed,
        resume: true,
        velocity: generateRandom(3, 10, s.seed),
        time: newTime,
    };

    // Create collision box for bird
    const bird_box = createBox(
        Constants.BIRD_X,
        s.position,
        Birb.WIDTH,
        Birb.HEIGHT,
    );

    // Check collision with top pipes
    const hit_top_results = s.pipes
        .map(p => {
            const top_pipe = createBox(
                p.x,
                0,
                Constants.PIPE_WIDTH,
                (p.gapY - p.gapHeight / 2) * Viewport.CANVAS_HEIGHT,
            );
            return isOverlap(bird_box, top_pipe);
        })
        .filter(result => result == true).length;

    // Handle hitting a top pipe or ceil
    const hit_top = hit_top_results > 0 || s.position <= Constants.CEILING;
    if (hit_top) {
        // If a new hit occurs, lives reduce by 1
        if (!s.resume) return hit_top_state;
        // Do not reduce lives continuously but fly through the pipe
        return { ...normal, resume: true };
    }

    // Check collision with bottom pipes
    const hit_bottom_results = s.pipes
        .map(p => {
            const bottom_pipe = createBox(
                p.x,
                (p.gapY + p.gapHeight / 2) * Viewport.CANVAS_HEIGHT,
                Constants.PIPE_WIDTH,
                Viewport.CANVAS_HEIGHT -
                    (p.gapY + p.gapHeight / 2) * Viewport.CANVAS_HEIGHT,
            );
            return isOverlap(bird_box, bottom_pipe);
        })
        .filter(result => result == true).length;

    // Handle hitting a bottom pipe or ground
    const hit_bottom = hit_bottom_results > 0 || s.position >= Constants.GROUND;
    if (hit_bottom) {
        // If a new hit occurs, lives reduce by 1
        if (!s.resume) return hit_bottom_state;
        // Do not reduce lives continuously but fly through the pipe
        return { ...normal, resume: true };
    }

    //Flying normally, continue with updated attribute values
    return normal;
};

// Rendering (side effects)

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

const render = (): ((s: State) => void) => {
    // Canvas elements
    const gameStart = document.querySelector("#gameStart") as SVGElement;
    const gameOver = document.querySelector("#gameOver") as SVGElement;
    const gameWin = document.querySelector("#gameWin") as SVGElement;
    const gamePause = document.querySelector("#gamePause") as SVGElement;

    // Text fields
    const livesText = document.querySelector("#livesText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;

    // Listen to button events to switch background color
    const darkBtn = document.querySelector("#darkBtn") as HTMLButtonElement;
    const lightBtn = document.querySelector("#lightBtn") as HTMLButtonElement;
    const canvas = document.querySelector("#svgCanvas") as HTMLElement;
    const setDarkMode = () => (canvas.style.backgroundColor = Viewport.DARK);
    const setLightMode = () => (canvas.style.backgroundColor = Viewport.LIGHT);
    darkBtn.addEventListener("click", setDarkMode);
    lightBtn.addEventListener("click", setLightMode);
    setDarkMode(); // default theme: dark

    // Create canvas
    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );

    // Add birb to the main grid canvas
    const birdImg = createSvgElement(svg.namespaceURI, "image", {
        href: "assets/birb.png",
        x: `${Constants.BIRD_X}`,
        y: `${Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT / 2}`,
        width: `${Birb.WIDTH}`,
        height: `${Birb.HEIGHT}`,
    });

    // Add star to the main grid canvas
    const starImg = createSvgElement(svg.namespaceURI, "image", {
        href: "assets/star.png",
        x: "0",
        y: "0",
        width: "30",
        height: "30",
    });

    // Add skull to the main grid canvas
    const skullImg = createSvgElement(svg.namespaceURI, "image", {
        href: "assets/skull.png",
        x: "0",
        y: "0",
        width: "30",
        height: "30",
    });

    // Define a function to create a top pipe
    const createTopPipe = (p: Pipe): SVGElement => {
        return createSvgElement(svg.namespaceURI, "rect", {
            x: p.x.toString(),
            y: "0",
            width: `${Constants.PIPE_WIDTH}`,
            height: `${(p.gapY - p.gapHeight / 2) * Viewport.CANVAS_HEIGHT}`,
            fill: p.special ? "orange" : "green",
        });
    };

    // Define a function to create a bottom pipe
    const createBottomPipe = (p: Pipe): SVGElement => {
        return createSvgElement(svg.namespaceURI, "rect", {
            x: p.x.toString(),
            y: `${(p.gapY + p.gapHeight / 2) * Viewport.CANVAS_HEIGHT}`,
            width: `${Constants.PIPE_WIDTH}`,
            height: `${Viewport.CANVAS_HEIGHT - (p.gapY + p.gapHeight / 2) * Viewport.CANVAS_HEIGHT}`,
            fill: p.special ? "orange" : "green",
        });
    };

    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */

    // Show gameStart tag initially
    show(gameStart);

    return (s: State) => {
        // Update the position of bird
        birdImg.setAttribute("y", `${s.position - Birb.HEIGHT / 2}`);

        // Remove ghosts in previous frame
        const existingGhosts = svg.querySelectorAll(".ghost");
        existingGhosts.forEach(bird => bird.remove());
        // Display ghosts belong to this frame
        s.ghosts
            .pipe(
                filter(bird => bird.time == s.time), // filter ghosts that belong to this frame by timestamp
                filter(bird => bird.run < s.run), // filter birds from previous runs
                map(bird => {
                    const ghostImg = createSvgElement(
                        svg.namespaceURI,
                        "image",
                        {
                            href: "assets/birb.png",
                            x: `${Constants.BIRD_X}`,
                            y: `${bird.y}`,
                            width: `${Birb.WIDTH}`,
                            height: `${Birb.HEIGHT}`,
                            opacity: "0.3",
                        },
                    );
                    ghostImg.classList.add("ghost"); // add a class for future selection
                    svg.appendChild(ghostImg);
                }),
            )
            .subscribe();

        // Remove pipe images in previous frame
        const existingPipes = svg.querySelectorAll(".pipe");
        existingPipes.forEach(pipe => pipe.remove());
        // Create images for pipes in this frame
        s.pipes.forEach(pipe => {
            const topPipe = createTopPipe(pipe);
            const bottomPipe = createBottomPipe(pipe);
            topPipe.classList.add("pipe");
            bottomPipe.classList.add("pipe");
            svg.appendChild(topPipe);
            svg.appendChild(bottomPipe);
        });

        // Update star and skull positions
        starImg.setAttribute("x", `${s.starx}`);
        starImg.setAttribute("y", `${s.stary}`);
        skullImg.setAttribute("x", `${s.skullx}`);
        skullImg.setAttribute("y", `${s.skully}`);
        svg.appendChild(starImg);
        svg.appendChild(skullImg);

        // Bring bird to top layer
        svg.appendChild(birdImg);

        // Update score and lives in status bar
        livesText.textContent = `${s.lives}`;
        scoreText.textContent = `${s.score}`;

        // Show or hide game-over/game-win/game-pause tag
        if (s.gameEnd) {
            if (s.lives === 0) {
                show(gameOver);
            } else {
                show(gameWin);
            }
        } else {
            hide(gameOver);
            hide(gameWin);
            if (s.gamePause) show(gamePause);
            else hide(gamePause);
        }
        hide(gameStart);
    };
};

export const state$ = (csvContents: string): Observable<State> => {
    //Parse csv string to a Pipe array
    const pipe_array = csvContents
        .split("\n")
        .slice(1)
        .map(row => {
            const [gap_y, gap_height, delay] = row.split(",");
            return {
                gapY: Number(gap_y),
                gapHeight: Number(gap_height),
                delay: Number(delay),
                special: Number(gap_y) > 0.75,
                passed: false,
                x: Viewport.CANVAS_WIDTH,
            } as Pipe;
        });

    // Create a pipe stream from Pipe array
    const pipes$ = pipe_array.map(p =>
        interval(Constants.TICK_RATE_MS).pipe(
            map(() => (currentState: State) => {
                // Do not update state.pipes when game is not going on
                if (currentState.gamePause || currentState.gameEnd)
                    return currentState;
                // Compute full score from pipe array
                if (currentState.fullScore == 0)
                    return {
                        ...currentState,
                        fullScore: pipe_array.reduce(
                            (sum, this_pipe) =>
                                sum + (this_pipe.special ? 2 : 1),
                            0,
                        ),
                    };
                // Add the pipe to state.pipes when timestamp reaches its delay
                if (currentState.time == p.delay * 1000) {
                    return {
                        ...currentState,
                        pipes: [...currentState.pipes, p],
                    };
                }
                return currentState;
            }),
        ),
    );

    // Create a separate stream to update pipe positions
    const movePipes$ = interval(Constants.TICK_RATE_MS).pipe(
        map(() => (currentState: State) => {
            // Move each pipe to the left by PIPE_SPEED
            if (currentState.gameEnd) return currentState;
            if (currentState.gamePause) return currentState;

            // pipes with updated positions
            const movedPipes = currentState.pipes.map(pipe => ({
                ...pipe,
                x: pipe.x - Constants.PIPE_SPEED,
            }));

            // pipes just passed
            const justPassedPipes = movedPipes.filter(
                pipe =>
                    !pipe.passed &&
                    pipe.x + Constants.PIPE_WIDTH < Constants.BIRD_X,
            );

            // got new score
            const newScore = justPassedPipes.reduce(
                (sum, pipe) => sum + (pipe.special ? 2 : 1),
                0,
            );

            const newPipes = movedPipes
                .map(pipe => ({
                    ...pipe,
                    passed:
                        pipe.x + Constants.PIPE_WIDTH < Constants.BIRD_X
                            ? true
                            : pipe.passed,
                }))
                .filter(pipe => pipe.x > -Constants.PIPE_WIDTH);

            return {
                ...currentState,
                pipes: newPipes,
                score: currentState.score + newScore,
            };
        }),
    );

    /**
     * Ghost stream
     * Stores birds in all previous runss, and displays them in next runs.
     */

    const ghost$ = interval(Constants.TICK_RATE_MS).pipe(
        map(() => (currentState: State) => {
            // Stop memorizing bird positions when game is not going on
            if (
                !currentState.gameStart ||
                currentState.gameEnd ||
                currentState.gamePause
            ) {
                return currentState;
            }
            // Add current time and position to state as a future ghost
            const new_ghosts = new ReplaySubject<Ghost>();
            const subscription = currentState.ghosts.subscribe({
                next: ghost => new_ghosts.next(ghost),
            });
            subscription.unsubscribe();
            new_ghosts.next({
                time: currentState.time,
                y: currentState.position,
                run: currentState.run,
            });
            return { ...currentState, ghosts: new_ghosts };
        }),
    );

    /**
     * Star stream
     * Manages spawning, movement, and collection of star power-ups
     * Gives +1 life when collected
     */
    const star$ = interval(Constants.TICK_RATE_MS).pipe(
        map(() => (currentState: State) => {
            if (
                !currentState.gameStart ||
                currentState.gameEnd ||
                currentState.gamePause
            )
                return currentState;
            // If bird eats star, it got 1 more life
            if (
                !currentState.resume &&
                Math.abs(currentState.stary - currentState.position) <= 20 &&
                Math.abs(currentState.starx - Constants.BIRD_X) <= 20
            )
                return {
                    ...currentState,
                    lives: currentState.lives + 1,
                    starx: -100,
                };
            // Make star available every 10 seconds
            if (currentState.time % 10000 === 3000)
                return {
                    ...currentState,
                    starx: generateRandom(
                        50,
                        Viewport.CANVAS_WIDTH,
                        currentState.seed,
                    ),
                    stary: generateRandom(
                        50,
                        Viewport.CANVAS_HEIGHT,
                        currentState.seed + 1,
                    ),
                };
            //Star moves leftward
            return {
                ...currentState,
                starx: currentState.starx - 10,
            };
        }),
    );

    /**
     * Skull hazard stream
     * Manages spawning, movement, and collision of skull hazards
     * Immediately ends game when collided with
     */
    const skull$ = interval(Constants.TICK_RATE_MS).pipe(
        map(() => (currentState: State) => {
            if (
                !currentState.gameStart ||
                currentState.gameEnd ||
                currentState.gamePause
            )
                return currentState;

            // If bird eats skull, it immediately dies
            if (
                !currentState.resume &&
                Math.abs(currentState.skully - currentState.position) <= 20 &&
                Math.abs(currentState.skullx - Constants.BIRD_X) <= 20
            )
                return {
                    ...currentState,
                    resume: true,
                    lives: 0,
                    skullx: -100,
                };
            // Make skull visible every 10 seconds
            if (currentState.time % 10000 === 2000) {
                const newSkullx = generateRandom(
                    50,
                    Viewport.CANVAS_WIDTH,
                    currentState.seed,
                );
                const newSkully = generateRandom(
                    50,
                    Viewport.CANVAS_HEIGHT,
                    currentState.seed + 1,
                );
                return {
                    ...currentState,
                    skullx: newSkullx,
                    skully: newSkully,
                };
            }
            // Skull moves leftward
            return {
                ...currentState,
                skullx: currentState.skullx - 10,
            };
        }),
    );

    /** User input */
    const key$ = fromEvent<KeyboardEvent>(document, "keypress");
    const fromKey = (keyCode: Key) =>
        key$.pipe(filter(({ code }) => code === keyCode));

    // Bird jumps when space is pressed
    const jump$ = fromKey("Space").pipe(
        // apply velocity change if the game is going on
        map(() => (currentState: State) => {
            if (
                !currentState.resume &&
                !currentState.gameEnd &&
                !currentState.gamePause
            )
                return {
                    ...currentState,
                    velocity: Constants.JUMP_SPEED, // Fixed upward velocity
                };
            return currentState;
        }),
    );

    // Press P to pause and resume game
    const pause$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
        filter(event => event.code === "KeyP"),
        map(() => (currentState: State) => {
            return { ...currentState, gamePause: !currentState.gamePause };
        }),
    );

    /** Determines the rate of time steps */
    const tick$ = interval(Constants.TICK_RATE_MS).pipe(map(() => tick));

    // Press R to restart game with existing ghosts
    const restart$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
        filter(event => event.code === "KeyR"),
        map(() => (currentState: State) => {
            return {
                ...initialState,
                run: currentState.run + 1,
                ghosts: currentState.ghosts,
            };
        }),
    );

    // Start unconditionally (a click has been made in csv$)
    const start$ = of(null);

    return start$.pipe(
        startWith(null),
        switchMap(() =>
            merge(
                jump$,
                tick$,
                ...pipes$,
                movePipes$,
                pause$,
                star$,
                skull$,
                ghost$,
                restart$,
            ).pipe(scan((s: State, reducerFn) => reducerFn(s), initialState)),
        ),
    );
};

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map2.csv`;

    // Get the file from URL
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) {
                return response.text();
            } else {
                throw new Error(`Fetch error: ${response.status}`);
            }
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            throw err;
        }),
    );

    // Observable: wait for first user click within the canvas(instead of whole page)
    const canvas = document.querySelector("#svgCanvas") as HTMLElement;
    const click$ = fromEvent(canvas, "mousedown").pipe(take(1));

    csv$.pipe(
        switchMap(contents =>
            // On click - start the game
            click$.pipe(switchMap(() => state$(contents))),
        ),
    ).subscribe(render());
}
