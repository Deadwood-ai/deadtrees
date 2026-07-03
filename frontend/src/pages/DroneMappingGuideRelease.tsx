import { useState, type FormEvent } from "react";

import type { GuideRelease } from "../data/releases";
import "./DroneMappingGuideRelease.css";

interface DroneMappingGuideReleaseProps {
  release: GuideRelease;
}

const FORMSPREE_ENDPOINT = "https://formspree.io/f/xpqgllrn";

function Chevron() {
  return (
    <svg
      className="guide-chevron"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export default function DroneMappingGuideRelease({
  release,
}: DroneMappingGuideReleaseProps) {
  const [formStatus, setFormStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const openSection = (sectionId: string) => {
    const target = document.getElementById(sectionId);
    if (!target) return;
    const details = target.tagName === "DETAILS" ? target : target.closest("details");
    if (details instanceof HTMLDetailsElement) {
      details.open = true;
    }
    window.setTimeout(
      () => target.scrollIntoView({ behavior: "smooth", block: "start" }),
      50,
    );
  };

  const handleJump = (sectionId: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openSection(sectionId);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setIsSubmitting(true);
    setFormStatus(null);

    try {
      const response = await fetch(FORMSPREE_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: formData,
      });

      if (!response.ok) throw new Error("Request failed");

      setFormStatus({
        kind: "success",
        message: "Thanks — we'll get back to you soon.",
      });
      form.reset();
    } catch {
      setFormStatus({
        kind: "error",
        message:
          "Something went wrong. Please try again, or email us directly at sarah.habershon@uni-leipzig.de.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="drone-guide-page" data-testid="release-detail-page">
      <div className="guide-page-hero">
        <div className="guide-page-eyebrow">
          deadtrees.earth — Contributor Guide
        </div>
        <h1>
          How to plan a <em>survey flight</em> for forest mapping
        </h1>

        <img
          src={release.guide.primaryImage}
          className="guide-strip-image"
          alt="Comic strip illustrating the drone mapping workflow"
        />

        <p>
          Contribute drone imagery of your local forest or green space to help
          monitor tree and forest health using AI. This guide will help you plan
          and execute a mission to contribute to global forest research.
        </p>
      </div>

      <div className="guide-jump-section">
        <div className="guide-jump-inner">
          <div className="guide-jump-label">Where are you starting from?</div>
          <div className="guide-jump-grid">
            <a
              className="guide-jump-card"
              href="#section-drone"
              onClick={handleJump("section-drone")}
            >
              <strong>I need a drone</strong>
              <span>Help me choose the right hardware</span>
            </a>
            <a
              className="guide-jump-card"
              href="#section-software"
              onClick={handleJump("section-software")}
            >
              <strong>I have a drone</strong>
              <span>Help me set up flight planning software</span>
            </a>
            <a
              className="guide-jump-card"
              href="#section-fly"
              onClick={handleJump("section-fly")}
            >
              <strong>I have everything</strong>
              <span>Ready to plan and fly my mission</span>
            </a>
            <a
              className="guide-jump-card"
              href="#section-upload"
              onClick={handleJump("section-upload")}
            >
              <strong>I have flight data</strong>
              <span>Upload it to deadtrees.earth</span>
            </a>
          </div>
        </div>
      </div>

      <main className="guide-main" data-testid="drone-guide-workflow">
        <details open id="section-why">
          <summary>
            <div className="guide-summary-left">
              <span className="guide-summary-title">About the project</span>
            </div>
            <Chevron />
          </summary>
          <div className="guide-section-body">
            <h3>Why do we need this data?</h3>
            <p>
              Forest decline is one of the most urgent problems in ecology, but
              its causes are very complex and hard to measure and understand.
              Forests die tree by tree. Unlike large scale deforestation, which
              can be mapped and monitored by satellites, individual tree deaths
              are dispersed throughout the forest. The European Space Agency’s
              Sentinel satellite fleet provides free global coverage of the
              world’s forests, but this data doesn’t offer high enough
              resolution to identify individual dead trees in a forest canopy.
              That sort of precision requires single-digit centimeter resolution
              – and for that you need a low-flying drone. This is where you come
              in.
              <br />
              <br />
              The deadtrees.earth project uses high resolution data gathered by
              drone pilots like you to train two sequential AI models.{" "}
              <a href="/dataset">
                The first detects tree cover, and identifies dead trees
              </a>
              . The second is trained on the output of the first,{" "}
              <a href="/deadtrees">
                to scale up the signal to the global reach of the Sentinel
                satellites
              </a>
              .
              <br />
              <br />
              These models give scientists unprecedented ability to monitor and
              analyse forest health, but to complete the satellite map for the
              whole world, we first need to gather enough training data to make
              the model reliable and accurate across all the world’s different
              ecosystems and forest types.
            </p>

            <h3>A call for drone pilots</h3>
            <p>
              If you would like to help, you’ll need a drone, some flight
              planning software, and an open green space with some trees.
              Programme a flight path in your flight planning software, pick a
              destination, and head out to conduct your survey flight. Once
              you’re done, zip the files and upload them to the deadtrees.earth
              platform. As well as contributing to a worldwide forest research
              project, you’ll also get free orthophoto processing and a map of
              the dead trees in your local forest.
            </p>

            <div className="guide-warn">
              <p>
                This is a first iteration of the drone mapping guide. It assumes
                you’re using a consumer drone, such as a DJI Mini or Mini 3 Pro,
                with an Android phone running Dronelink. Further information for
                alternative drone manufacturers and flight planning software
                options is forthcoming. Feel free to make a pull request on this
                repository if you would like to contribute and improve the guide.
              </p>
            </div>
          </div>
        </details>

        <details id="section-drone">
          <summary>
            <div className="guide-summary-left">
              <span className="guide-summary-num">01</span>
              <span className="guide-summary-title">Choosing a drone</span>
            </div>
            <Chevron />
          </summary>
          <div className="guide-section-body">
            <h3>Size and weight: know the limits</h3>
            <p>
              In the UK and EU you must hold a valid flyer ID and operator ID to
              fly any drone over 250g outdoors. Some survey altitudes and
              locations require additional authorisation. Always check local
              regulations before flying:{" "}
              <ExternalLink href="https://dronemaps24.org/">
                dronemaps24.org
              </ExternalLink>
            </p>
            <p>
              Drones under 250g are generally exempt from registration
              requirements and don't require a pilot licence in most countries.
              The entire DJI Mini series is built to hit 249g exactly — this
              makes it a sensible choice.
            </p>

            <div className="guide-warn">
              <p>
                If buying a DJI Mini, make sure you get the version with the
                standard RC-N1 controller — the one where your phone clips onto
                the front. The RC controller with a built-in screen may prevent
                flight planning software from connecting.
              </p>
            </div>
          </div>
        </details>

        <details id="section-software">
          <summary>
            <div className="guide-summary-left">
              <span className="guide-summary-num">02</span>
              <span className="guide-summary-title">
                Flight planning software
              </span>
            </div>
            <Chevron />
          </summary>
          <div className="guide-section-body">
            <p>
              This is the software you’ll use to programme a flight path, with
              the correct parameters for orthophoto processing. Flight planning
              software is separate from your drone's own app (e.g. DJI Fly).
            </p>
            <p>
              If you are using a DJI drone with a compatible DJI controller, you
              may already be able to plan and execute survey flights directly
              through the controller’s integrated flight application. This is
              common with enterprise drones and controllers that support
              applications such as DJI Pilot 2.
            </p>
            <p>
              If your controller does not include suitable flight-planning
              software, or you are flying the drone through a smartphone or
              tablet, you can use one of the following third-party applications.
            </p>

            <div className="guide-sw-pair">
              <div className="guide-sw-col">
                <div className="guide-sw-name">Dronelink</div>
                <span className="guide-sw-price">
                  subscription / one-off from ~€60
                </span>
                <p>
                  Dronelink is a drone flight planning and automation app. It
                  lets you map a grid over a chosen area, set your flight
                  parameters, and execute the mission automatically.
                </p>
                <p>
                  A Hobbyist plan (one-off, ~€60) is enough for flat terrain.
                  A Professional subscription is required for terrain awareness,
                  which matters in mountainous regions. See{" "}
                  <ExternalLink href="https://app.dronelink.com/pricing">
                    pricing
                  </ExternalLink>
                  .
                </p>
                <ul>
                  <li>
                    DJI Mini 4 Pro <em>(Android)</em>
                  </li>
                  <li>
                    DJI Mini 3 &amp; Mini 3 Pro <em>(Android)</em>
                  </li>
                  <li>
                    DJI Mini 2 <em>(Android &amp; iOS)</em>
                  </li>
                  <li>
                    DJI Mini / Mini SE <em>(Android &amp; iOS)</em>
                  </li>
                  <li>
                    DJI Air 2S <em>(Android &amp; iOS)</em>
                  </li>
                  <li>
                    DJI Phantom 3 &amp; 4 Series <em>(Android &amp; iOS)</em>
                  </li>
                  <li>
                    DJI Air 2 <em>(Android &amp; iOS)</em>
                  </li>
                  <li>
                    DJI Mavic 2 Dual / Pro / Zoom <em>(Android &amp; iOS)</em>
                  </li>
                  <li>
                    DJI Mavic Pro Series <em>(Android &amp; iOS)</em>
                  </li>
                  <li>
                    <ExternalLink href="https://www.dronelink.com/supported-drones">
                      ...see all compatible drones.
                    </ExternalLink>
                  </li>
                </ul>
                <div className="guide-sw-warn">
                  Download from the{" "}
                  <ExternalLink href="https://www.dronelink.com/download">
                    website only
                  </ExternalLink>{" "}
                  — not the app store.
                </div>
              </div>

              <div className="guide-sw-col">
                <div className="guide-sw-name">Litchi</div>
                <span className="guide-sw-price">one-off ~€29</span>
                <p>
                  Litchi is an alternative flight planning option with a one-off
                  payment model. Missions are planned in advance on your
                  computer via Litchi Hub, then synced to the app on your phone
                  for the field. For some drones you can export the mission and
                  import it to your RC controller directly.
                </p>
                <ul>
                  <li>DJI Mini 4 Pro</li>
                  <li>DJI Mini 3 &amp; Mini 3 Pro</li>
                  <li>DJI Matrice 4 (4E, 4T, 4D, 4TD)</li>
                  <li>DJI Mavic 3 Enterprise (3E, 3T, 3M)</li>
                  <li>DJI Matrice 30</li>
                  <li>DJI Matrice 300 &amp; 350 RTK</li>
                  <li>DJI Matrice 400</li>
                  <li>
                    <ExternalLink href="https://www.litchiutilities.com/docs/waypoint.php">
                      ...see all compatible drones.
                    </ExternalLink>
                  </li>
                </ul>
                <div className="guide-sw-warn">
                  <p>
                    Plan at{" "}
                    <ExternalLink href="https://hub.flylitchi.com/">
                      hub.flylitchi.com
                    </ExternalLink>{" "}
                    -{" "}
                    <ExternalLink href="https://parse.litchiapi.com/app/com.flylitchi.litchipilot.dji/beta/latest">
                      download Litchi Pilot
                    </ExternalLink>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </details>

        <details id="section-fly">
          <summary>
            <div className="guide-summary-left">
              <span className="guide-summary-num">03</span>
              <span className="guide-summary-title">
                Planning &amp; flying your mission
              </span>
            </div>
            <Chevron />
          </summary>
          <div className="guide-section-body">
            <p>
              This assumes you have a drone, flight planning software, and a
              phone that works with both.
            </p>

            <h3>Mission settings</h3>
            <p>
              In your flight planning app, select the area you want to cover.
              Try to cover about 10-15 hectares. For most consumer drones,
              that's about how much you’ll get per battery. To reduce altitude
              changes and get the most out of your battery, plan your flight
              grid to follow the terrain gradient rather than cutting across it.
            </p>
            <p>When you programme your flight path, use these parameters:</p>

            <div className="guide-params">
              <div className="guide-param-row">
                <div className="guide-param-key">Front overlap</div>
                <div className="guide-param-val">90%</div>
              </div>
              <div className="guide-param-row">
                <div className="guide-param-key">Side overlap</div>
                <div className="guide-param-val">80%</div>
              </div>
              <div className="guide-param-row">
                <div className="guide-param-key">Flight height</div>
                <div className="guide-param-val">80–120m (relative to ground)</div>
              </div>
              <div className="guide-param-row">
                <div className="guide-param-key">Gimbal pitch</div>
                <div className="guide-param-val">-90° (straight down)</div>
              </div>
              <div className="guide-param-row">
                <div className="guide-param-key">White balance</div>
                <div className="guide-param-val">Fixed — not Auto</div>
              </div>
              <div className="guide-param-row">
                <div className="guide-param-key">Photo format</div>
                <div className="guide-param-val">JPEG</div>
              </div>
            </div>

            <p>Everything else can stay at default settings.</p>

            <div className="guide-warn">
              <p>
                Do not fly above 120m without checking local regulations — this
                usually requires a special permit. Some drones have a 120m
                software ceiling built in.
              </p>
            </div>

            <h3>The flight</h3>
            <p>
              Always check local flight restrictions before flying:{" "}
              <ExternalLink href="https://dronemaps24.org/">
                dronemaps24.org
              </ExternalLink>
              .
            </p>
            <p>
              Before you attempt an automated mission, practice flying manually
              to ensure you’re comfortable with takeoff, landing, and basic
              controls. Make sure you’ve identified the return-to-home button on
              the remote, so you can recall the drone if it starts to behave
              alarmingly.
              <br />
              <br />
              Choose your take-off point so you have a direct line of sight to
              the drone throughout the flight. The remote controller must
              maintain connection the entire time. Some trees are fine;
              disappearing behind a hill is not! If you’re mapping hilly
              terrain, bear in mind that some drones have a software-enforced
              120m ceiling above take-off elevation, so consider positioning
              yourself higher on the slope for launching.
              <br />
              <br />
              The flight is automatic once started, but stay alert; your job is
              to monitor and be ready to intervene. If you need to take back
              manual control of the drone, press pause in Dronelink and the
              controller sticks on your remote will reactivate. Now you’re
              flying the drone manually again.
            </p>
            <p>
              Don’t worry if the drone returns before completing the mission —
              all captured data is usable.
            </p>

            <hr className="guide-rule" />
            <h3>Executing the mission (Dronelink)</h3>
            <p>
              <em>Instructions for Litchi are coming soon.</em>
            </p>

            <ol className="guide-steps">
              <li>
                <span className="guide-step-n">1</span>
                <span className="guide-step-text">
                  Power on the controller and drone.
                </span>
              </li>
              <li>
                <span className="guide-step-n">2</span>
                <span className="guide-step-text">
                  Open Dronelink, keeping DJI Fly running in the background.
                  Dronelink talks to the drone through DJI Fly.
                </span>
              </li>
              <li>
                <span className="guide-step-n">3</span>
                <span className="guide-step-text">
                  Open your saved mission in Dronelink.
                </span>
              </li>
              <li>
                <span className="guide-step-n">4</span>
                <span className="guide-step-text">
                  Wait for GPS lock — aim for 10+ satellites before proceeding.
                </span>
              </li>
              <li>
                <span className="guide-step-n">5</span>
                <span className="guide-step-text">
                  Note your launch point. This is where the drone will return
                  automatically if it loses signal or battery gets critically
                  low.
                </span>
              </li>
              <li>
                <span className="guide-step-n">6</span>
                <span className="guide-step-text">
                  Tap Fly / Execute. Review the pre-flight summary — altitude,
                  area, estimated time — and confirm.
                </span>
              </li>
              <li>
                <span className="guide-step-n">7</span>
                <span className="guide-step-text">
                  The drone takes off and flies the grid automatically. Monitor
                  it and keep an eye on battery throughout.
                </span>
              </li>
            </ol>

            <h3>Battery management</h3>
            <p>
              The drone warns you when battery is low. Try to have the drone
              grounded at minimum 20% battery to keep it safe. To continue a
              mission after a battery swap just replace the battery and press
              play — the drone will return to where it last captured images and
              resume its mission.
            </p>

            <h3>Landing</h3>
            <p>
              If you’re using a consumer drone, it’s safest to land manually —
              GPS is not precise enough for an automatic landing at a precise
              spot. When the mission ends and the drone is hovering nearby, take
              over manually and bring it down with the controller.
            </p>
          </div>
        </details>

        <details id="section-upload">
          <summary>
            <div className="guide-summary-left">
              <span className="guide-summary-num">04</span>
              <span className="guide-summary-title">
                Contributing to deadtrees.earth
              </span>
            </div>
            <Chevron />
          </summary>
          <div className="guide-section-body">
            <p>
              Once your mission is complete, return to base! Upload the data
              you’ve collected to deadtrees.earth for orthomosaic processing and
              tree identification.
            </p>

            <img
              src={release.guide.secondaryImage}
              className="guide-strip-image"
              alt="Comic strip illustrating how orthophotos are made"
            />

            <ol className="guide-steps">
              <li>
                <span className="guide-step-n">1</span>
                <span className="guide-step-text">
                  Pull all raw images from the drone's SD card to your computer.
                  Keep each flight's images in a separate folder.
                </span>
              </li>
              <li>
                <span className="guide-step-n">2</span>
                <span className="guide-step-text">
                  Zip each flight's folder into a single archive (.zip), so that
                  there's one zip file per flight.
                </span>
              </li>
              <li>
                <span className="guide-step-n">3</span>
                <span className="guide-step-text">
                  Go to <a href="/profile">deadtrees.earth/profile</a> and log
                  in or register.
                </span>
              </li>
              <li>
                <span className="guide-step-n">4</span>
                <span className="guide-step-text">
                  Press Upload and fill in the metadata form (see below).
                </span>
              </li>
              <li>
                <span className="guide-step-n">5</span>
                <span className="guide-step-text">
                  Submit. Your data will be processed automatically and made
                  available to the global research community. Come back when
                  processing is complete to see what you’ve made!
                </span>
              </li>
            </ol>

            <h3>Metadata fields</h3>

            <div className="guide-meta-table">
              <div className="guide-meta-row">
                <div className="guide-meta-key star">Acquisition date ★</div>
                <div className="guide-meta-val">
                  The date of the flight — not the upload date. This is the most
                  important field.
                </div>
              </div>
              <div className="guide-meta-row">
                <div className="guide-meta-key">Authors</div>
                <div className="guide-meta-val">Your name, and anyone who helped.</div>
              </div>
              <div className="guide-meta-row">
                <div className="guide-meta-key">Platform</div>
                <div className="guide-meta-val">
                  Leave as Drone. "Airborne" refers to fixed-wing aircraft.
                </div>
              </div>
              <div className="guide-meta-row">
                <div className="guide-meta-key">DOI</div>
                <div className="guide-meta-val">
                  Only relevant if linking a research publication. Leave blank
                  otherwise.
                </div>
              </div>
              <div className="guide-meta-row">
                <div className="guide-meta-key">Additional info</div>
                <div className="guide-meta-val">
                  Optional but useful — drone model, weather conditions,
                  dominant tree species, suspected cause of death.
                </div>
              </div>
            </div>

            <p>
              Once the processing is complete, take a look at the results in the
              Drone data archive. The platform processes your data into an
              orthomosaic, identifies tree cover, and highlights dead trees. The
              result is both an image map and a tree cover + dead trees layer. If
              you use the platform for your own project, whether it's monitoring
              tree health in your neighborhood, monitoring a forestry block, or
              estimating shade cover in your city, we would love to hear about
              it!
            </p>
          </div>
        </details>

        <details id="section-feedback">
          <summary>
            <div className="guide-summary-left">
              <span className="guide-summary-num">04</span>
              <span className="guide-summary-title">Questions and feedback</span>
            </div>
            <Chevron />
          </summary>
          <div className="guide-section-body">
            <p className="guide-contact-box-sub">
              Do you have a question? Did we leave something important out of
              the guide? Drop us a line and we’ll write back to you. If you’ve
              flown with a different drone or flight planning software, and
              would like to contribute instructions for others, please write to
              us or alternatively feel free to open a pull request on the{" "}
              <ExternalLink href={release.guide.repositoryUrl}>
                guide’s repository
              </ExternalLink>{" "}
              instead.
            </p>

            <div className="guide-author-card">
              <img
                src="/assets/guides/drone-mapping/sarah-habershon.jpg"
                alt="Sarah Habershon"
                loading="lazy"
              />
              <div>
                <div className="guide-author-kicker">Guide author</div>
                <div className="guide-author-name">Sarah Habershon</div>
                <p>
                  Research Fellow at Leipzig University and research assistant
                  in the COCAP project, working with remote sensing for
                  journalism, human rights monitoring, and environmental
                  accountability.
                </p>
                <ExternalLink href="https://rsc4earth.de/author/sarah-habershon/">
                  View Sarah’s RSC4Earth profile
                </ExternalLink>
              </div>
            </div>

            <form className="guide-contact-form" onSubmit={handleSubmit}>
              <input
                type="hidden"
                name="_subject"
                value="Drone mapping guide — feedback"
              />
              <div className="guide-form-field">
                <label htmlFor="feedback-email">Your email</label>
                <input
                  type="email"
                  id="feedback-email"
                  name="email"
                  placeholder="you@example.com"
                  required
                />
              </div>
              <div className="guide-form-field">
                <label htmlFor="feedback-message">Your question or feedback</label>
                <textarea
                  id="feedback-message"
                  name="message"
                  placeholder="Got a question?"
                  required
                />
              </div>
              <button
                type="submit"
                className="guide-form-submit"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Sending..." : "Send"}
              </button>
              {formStatus ? (
                <div className={`guide-form-status ${formStatus.kind}`}>
                  {formStatus.message}
                </div>
              ) : null}
            </form>
          </div>
        </details>
      </main>

      <footer className="guide-footer">
        <span>
          Part of the <a href="/">deadtrees.earth</a> open science project
        </span>
        <span>
          <a href="/profile">Upload data</a> · <a href="/releases">Releases</a>
        </span>
      </footer>
    </div>
  );
}
