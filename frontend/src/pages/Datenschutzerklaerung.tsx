import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";
import { useNavigate } from "react-router-dom";

const { Title, Paragraph } = Typography;

export default function Datenschutzerklaerung() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-4xl px-4 pt-28 pb-12">
      <Button
        className="md:hidden"
        type="default"
        size="large"
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate("/")}
      >
        Zurück
      </Button>
      <Title level={1}>Datenschutzerklärung</Title>
      <Paragraph type="secondary">Stand / Last updated: 7. Oktober 2026 / 7 October 2026</Paragraph>
      <div className="space-y-8">
        <Title level={2}>Deutsch</Title>
        <section>
          <Title level={3}>Verantwortlicher</Title>
          <Paragraph>
            Universität Freiburg
            <br />
            Professur für Sensorgestützte Geoinformatik
            <br />
            Tennenbacher Str. 4<br />
            79106 Freiburg
            <br />
            Deutschland
            <br />
            E-Mail: sekretariat@geosense.uni-freiburg.de
            <br />
            Telefon: +49 (0)761 203 – 3694
          </Paragraph>
          <Paragraph>
            Datenschutzbeauftragter:
            <br />
            Albert-Ludwigs-Universität Freiburg
            <br />
            Der Datenschutzbeauftragte
            <br />
            Fahnenbergplatz
            <br />
            79085 Freiburg
            <br />
            E-Mail: datenschutzbeauftragter@zv.uni-freiburg.de
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Allgemeine Hinweise zur Datenverarbeitung</Title>
          <Paragraph>
            Wir verarbeiten personenbezogene Daten im Einklang mit den Bestimmungen der Datenschutzgrundverordnung
            (DSGVO) und dem Bundesdatenschutzgesetz (BDSG). Die DSGVO ist eine europäische Verordnung, welche den
            Datenschutz in der europäischen Union einheitlich regelt. Das BDSG ergänzt die DSGVO auf nationaler Ebene.
            Die konkreten Rechtsgrundlagen werden in den jeweiligen Abschnitten dieser Erklärung genannt. Wir
            verarbeiten dabei so wenige Daten wie möglich. Daten werden nur so lange gespeichert, wie sie für den
            jeweiligen Zweck erforderlich sind oder gesetzliche Aufbewahrungsfristen bestehen.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Bereitstellung der Website und Server-Logfiles</Title>
          <Paragraph>
            Unsere Website wird auf Servern der Hetzner Online GmbH in Deutschland gehostet. Beim Aufruf unserer Website
            werden automatisch folgende Daten erhoben: IP-Adresse (sofern möglich durch Kürzung anonymisiert),
            Datum/Uhrzeit des Zugriffs, aufgerufene Seite, Browsertyp, Betriebssystem und Referrer-URL. Diese
            Datenverarbeitung erfolgt auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an der
            technischen Bereitstellung, der Sicherheit der IT-Systeme sowie der Sicherstellung eines störungsfreien
            Betriebs der Website, insbesondere zur Erkennung und Abwehr von Angriffen und zur Verbesserung der
            Systemstabilität). Die Daten werden in der Regel nach 7-14 Tagen gelöscht.
          </Paragraph>
          <Paragraph>
            Wir behalten uns vor, bestimmte Log- und Analyse-Daten über den zuvor genannten Zeitraum hinaus in
            aggregierter Form aufzubewahren, um unsere Plattform langfristig zu verbessern und statistische Auswertungen
            vorzunehmen. Diese aggregierten Daten enthalten keine direkten personenbezogenen Merkmale, sondern dienen
            ausschließlich der Optimierung unserer Angebote und der Sicherstellung des Betriebs.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Schutz vor Missbrauch und Nutzungsbegrenzungen</Title>
          <Paragraph>
            Um die Plattform vor automatisierter und massenhafter Nutzung zu schützen, begrenzen wir bestimmte Anfragen
            pro Nutzerkonto bzw. pro Netzwerk. Dazu speichern wir für Besucher ohne Nutzerkonto einen nicht
            umkehrbaren, mit einem geheimen Schlüssel gebildeten Hashwert der IP-Adresse; diese Einträge werden nur für einen Tag berücksichtigt und danach im laufenden Betrieb automatisch gelöscht.
            Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse am Schutz und an der Verfügbarkeit
            der Plattform).
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Cookies</Title>
          <Paragraph>
            Wir setzen Cookies ein, sobald Sie ein Nutzerkonto erstellen und sich anmelden. Diese Cookies dienen dazu,
            Ihre Sitzung aufrechtzuerhalten und den erneuten Login zu erleichtern. Die Cookies sind dabei 30 Tage
            gültig. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an einer nutzerfreundlichen
            Gestaltung). Sie werden darauf hingewiesen, dass die Nutzung dieser Webseite Cookies setzt. Sie können
            Cookies im Browser löschen oder blockieren; dies kann jedoch zu Funktionseinschränkungen führen.
          </Paragraph>
          <Paragraph>
            Bei Aktualisierungen unserer Cookie-Richtlinien oder Änderungen an den Tracking-Technologien werden Sie
            aufgefordert, Ihre Cookie-Einstellungen zu erneuern. In der Zeit zwischen der Aktualisierung und Ihrer
            erneuten Einwilligung werden nur für die Funktionalität der Website notwendige Daten verarbeitet. Die
            Versionierung der Cookie-Einstellungen stellt sicher, dass Ihre Einwilligung stets den aktuellen Praktiken
            entspricht.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Nutzerbeiträge und hochgeladene Inhalte</Title>
          <Paragraph>
            Nutzer können Bilder oder Geodaten zur Erforschung globaler Baumsterblichkeitsdynamiken beitragen. Bitte
            vermeiden Sie das Hochladen personenbezogener Daten. Falls solche Daten dennoch enthalten sind, werden sie
            auf Basis Ihrer Einwilligung (Art. 6 Abs. 1 lit. a DSGVO) verarbeitet. Hochgeladene
            Daten einschließlich ihrer Metadaten (z. B. in Bilddateien enthaltene Aufnahmeinformationen) werden für die
            Verarbeitung und für die Forschung gespeichert, auch zum Trainieren von Modellen; Einzelheiten regeln die
            Nutzungsbedingungen. Wer die Daten auf der Plattform sehen und herunterladen kann, hängt von der gewählten
            Sichtbarkeit ab. Unzulässige Inhalte können gelöscht werden. Nutzer können die Löschung ihrer Inhalte
            jederzeit beantragen, indem sie eine E-Mail an den oben genannten Verantwortlichen senden.
          </Paragraph>
          <Paragraph>
            Sollten auf hochgeladenen Bildern oder Geodaten identifizierbare Personen sichtbar sein oder Ortsangaben
            Rückschlüsse auf Privatgrundstücke ermöglichen, liegt es in der Verantwortung der hochladenden Person, vorab
            entsprechende Einwilligungen einzuholen oder die Daten zu anonymisieren. Betroffene Personen können einen
            Antrag auf Unkenntlichmachung (Blurring) oder vollständige Löschung dieser Daten stellen. Bitte richten Sie
            entsprechende Anfragen an den Verantwortlichen oder Datenschutzbeauftragten.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Kontaktaufnahme</Title>
          <Paragraph>
            Bei Kontakt per E-Mail werden Ihre E-Mail-Adresse und weitere von Ihnen zur Verfügung gestellte Daten zur
            Bearbeitung Ihrer Anfrage verarbeitet. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung),
            wenn die Kontaktaufnahme für die Erbringung einer Dienstleistung oder eines Vertrags notwendig ist,
            ansonsten Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse). Nach abschließender Bearbeitung der Anfrage
            werden die Daten gelöscht, sofern keine gesetzlichen Aufbewahrungspflichten entgegenstehen, im Regelfall
            nach 3-6 Monaten.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Empfänger von Daten</Title>
          <Paragraph>
            Eine Weitergabe personenbezogener Daten an Dritte erfolgt nur, wenn dies gesetzlich vorgeschrieben ist, zur
            Vertragserfüllung erforderlich ist oder Sie eingewilligt haben. Dies betrifft folgende Dienste:
          </Paragraph>
          <Paragraph>
            Hetzner Online GmbH (Hosting Provider)
            <br />
            Google Ireland Ltd. (Firebase Hosting)
            <br />
            Supabase Inc. (Datenbank und Anmeldung / database and sign-in)
            <br />
            PostHog Inc. (PostHog Analytics)
            <br />
            Sendinblue GmbH (Brevo, E-Mail-Versand / email delivery)
            <br />
            Cloudflare Inc. (Turnstile)
            <br />
            Kartenanbieter / map providers (Esri, MapTiler, OpenStreetMap-basierte Dienste / OpenStreetMap-based services)
          </Paragraph>
          <Paragraph>
            Dienste von Drittanbietern werden im Rahmen der datenschutzrechtlichen Vorgaben genutzt. Es kann zu einer
            Datenverarbeitung außerhalb der EU kommen. Es folgt eine detaillierte Übersicht der Dienste.
          </Paragraph>

          <Title level={4}>Hetzner Online GmbH</Title>
          <Paragraph>
            Zweck: Server-Hosting für Dateispeicherung, einschließlich Datensätze und generierte Kartendaten.
            <br />
            Datenverarbeitung:
            <br />
            - Hochgeladene Dateien (z. B. Drohnenbilder, GeoJSON-Daten)
            <br />
            - Generierte Thumbnails und Cloud-Optimized GeoTIFFs (COGs)
            <br />
            - Serverzugriffsprotokolle (IP-Adressen, Zeitstempel, Browsertypen)
            <br />
            Datenstandort: Server in Deutschland.
            <br />
            Datenhandling: IP-Adressen in Serverlogs werden zur Anonymisierung gekürzt und ausschließlich für technische
            Fehlerbehebung und Sicherheitsüberwachung genutzt.
            <br />
            Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (sichere Hosting-Infrastruktur).
            <br />
            Datenspeicherung: Serverlogs werden für 7–14 Tage gespeichert.
          </Paragraph>

          <Title level={4}>Google Ireland Ltd.</Title>
          <Paragraph>
            Zweck: Auslieferung (Hosting) der Web-Anwendung.
            <br />
            Datenverarbeitung:
            <br />
            - Technische Zugriffsdaten (z. B. IP-Adressen, Zeitstempel, Browserinformationen)
            <br />
            Datenstandort: Hauptsächlich EU-Server, mögliche Übermittlung außerhalb der EU.
            <br />
            Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an einer sicheren und stabilen Bereitstellung der Website).
            <br />
            Datenspeicherung: Gemäß den Standardrichtlinien von Firebase.
          </Paragraph>

          <Title level={4}>Supabase Inc.</Title>
          <Paragraph>
            Zweck: Bereitstellung von Datenbankdiensten, Nutzer-Authentifizierung und Dateimetadaten-Management.
            <br />
            Datenverarbeitung:
            <br />
            - E-Mail-Adressen (für Authentifizierung)
            <br />
            - Metadaten zu Datensätzen und deren Bearbeitungsstatus
            <br />
            - Logs zu Nutzerinteraktionen (z. B. Uploads, Dateiaktionen)
            <br />
            Datenstandort: Server in der EU.
            <br />
            Datenhandling: Authentifizierungsdaten werden sicher gespeichert, Metadaten enthalten Nutzer-IDs und
            JSONB-Datenspeicherung.
            <br />
            Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Erfüllung vertraglicher Pflichten).
            <br />
            Datenspeicherung: Solange das Nutzerkonto besteht oder bis zur Nutzer-initiierten Löschung.
          </Paragraph>

          <Title level={4}>PostHog Inc.</Title>
          <Paragraph>
            Zweck: Analyse der Nutzung zur Verbesserung der Plattform.
            <br />
            Datenverarbeitung:
            <br />
            - Ohne Einwilligung: nur grundlegende, nicht dauerhaft gespeicherte Nutzungsdaten (z. B. Seitenaufrufe) ohne Analyse-Cookies.
            <br />
            - Mit Einwilligung über das Cookie-Banner: Nutzungsdaten (Klickpfade, Seitenaufrufe, Funktionsnutzung), Geräte- und Browserinformationen sowie Sitzungsaufzeichnungen. Bei angemeldeten Nutzern werden diese Daten dem Nutzerkonto zugeordnet, einschließlich E-Mail-Adresse und Name.
            <br />
            Datenstandort: Server innerhalb der EU.
            <br />
            Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO (Einwilligung) für die Analyse mit Cookies; im Übrigen Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse am Betrieb und an der Verbesserung der Plattform).
            <br />
            Widerruf: Sie können Ihre Einwilligung jederzeit über die Cookie-Einstellungen widerrufen.
          </Paragraph>

          <Title level={4}>Sendinblue GmbH (Brevo)</Title>
          <Paragraph>
            Zweck: Versand von E-Mails der Plattform (z. B. Bestätigung des Nutzerkontos, Benachrichtigungen zu Datensätzen).
            <br />
            Datenverarbeitung: E-Mail-Adresse und Inhalt der Nachricht.
            <br />
            Datenstandort: Server in der EU.
            <br />
            Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Bereitstellung des Nutzerkontos und der Plattform).
          </Paragraph>

          <Title level={4}>Cloudflare Inc. (Turnstile)</Title>
          <Paragraph>
            Zweck: Schutz der Registrierung vor automatisierten Anmeldungen (Bots).
            <br />
            Datenverarbeitung: IP-Adresse sowie Geräte- und Browserinformationen während der Prüfung.
            <br />
            Datenstandort: Mögliche Verarbeitung außerhalb der EU, insbesondere in den USA.
            <br />
            Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse am Schutz der Plattform vor Missbrauch).
          </Paragraph>

          <Title level={4}>Kartenanbieter</Title>
          <Paragraph>
            Zweck: Anzeige von Hintergrundkarten und Luftbildern (Esri, MapTiler und OpenStreetMap-basierte Dienste).
            <br />
            Datenverarbeitung: IP-Adresse und angefragte Kartenausschnitte, die Ihr Browser direkt beim jeweiligen Anbieter abruft.
            <br />
            Datenstandort: Je nach Anbieter mögliche Verarbeitung außerhalb der EU.
            <br />
            Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an der Kartendarstellung).
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Ihre Rechte</Title>
          <Paragraph>
            Sie haben folgende Rechte: Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16 DSGVO), Löschung (Art. 17 DSGVO),
            Einschränkung der Verarbeitung (Art. 18 DSGVO), Datenübertragbarkeit (Art. 20 DSGVO) sowie Widerspruch gegen
            die Verarbeitung (Art. 21 DSGVO) und Widerruf von Einwilligungen (Art. 7 Abs. 3 DSGVO).
          </Paragraph>
          <Paragraph>
            Sie können Ihre Rechte ausüben, indem Sie sich über die oben angegebenen Kontaktdaten an den
            Verantwortlichen oder den Datenschutzbeauftragten wenden. Sie haben zudem das Recht, bei einer
            Aufsichtsbehörde Beschwerde einzulegen, wenn Sie der Ansicht sind, dass die Verarbeitung Ihrer Daten gegen
            geltendes Recht verstößt. Zuständige Aufsichtsbehörde ist der Landesbeauftragte für den Datenschutz und die
            Informationsfreiheit Baden-Württemberg, Lautenschlagerstraße 20, 70173 Stuttgart, Deutschland (E-Mail:
            poststelle@lfdi.bwl.de).
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Änderungen dieser Datenschutzerklärung</Title>
          <Paragraph>
            Wir behalten uns vor, diese Datenschutzerklärung bei Bedarf anzupassen. Die aktuelle Version ist jederzeit
            auf dieser Website abrufbar. Änderungen werden hier auf der Seite publiziert und Ihnen ggf. per E-Mail
            mitgeteilt.
          </Paragraph>
        </section>

        {/* English Version */}
        <Title level={2}>English</Title>
        <section>
          <Title level={3}>Controller</Title>
          <Paragraph>
            Universität Freiburg
            <br />
            Professur für Sensorgestützte Geoinformatik
            <br />
            Tennenbacher Str. 4
            <br />
            79106 Freiburg
            <br />
            Germany
            <br />
            Email: sekretariat@geosense.uni-freiburg.de
            <br />
            Phone: +49 (0)761 203 – 3694
          </Paragraph>
          <Paragraph>
            Data Protection Officer:
            <br />
            Albert-Ludwigs-Universität Freiburg
            <br />
            Der Datenschutzbeauftragte
            <br />
            Fahnenbergplatz
            <br />
            79085 Freiburg
            <br />
            Email: datenschutzbeauftragter@zv.uni-freiburg.de
          </Paragraph>
        </section>

        <section>
          <Title level={3}>General Information on Data Processing</Title>
          <Paragraph>
            We process personal data in accordance with the provisions of the General Data Protection Regulation (GDPR)
            and the German Federal Data Protection Act (BDSG). The GDPR is a European regulation that standardizes data
            protection across the European Union. The BDSG supplements the GDPR at the national level. The specific
            legal bases are stated in the respective sections of this policy. We process as little data as possible.
            Data is stored only as long as necessary for the respective purpose or as required by statutory retention
            periods.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Provision of the Website and Server Log Files</Title>
          <Paragraph>
            Our website is hosted on servers of Hetzner Online GmbH in Germany. When visiting our website, the following
            data is automatically collected:
            <br />
            - IP address (anonymized if possible by truncation)
            <br />
            - Date/time of access
            <br />
            - Accessed page
            <br />
            - Browser type
            <br />
            - Operating system
            <br />- Referrer URL
          </Paragraph>
          <Paragraph>
            This data processing is based on Art. 6(1)(f) GDPR (legitimate interest in the technical provision, security
            of IT systems, and ensuring the smooth operation of the website, particularly to detect and prevent attacks
            and improve system stability). The data is usually deleted after 7-14 days.
          </Paragraph>
          <Paragraph>
            We reserve the right to retain certain log and analysis data beyond this period in an aggregated form to
            improve our platform in the long term and perform statistical evaluations. These aggregated data do not
            contain any directly identifiable personal characteristics and are used solely to optimize our services and
            ensure operational stability.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Protection Against Abuse and Usage Limits</Title>
          <Paragraph>
            To protect the Platform against automated and bulk use, we limit certain requests per user account or per
            network. For visitors without an account, we store a non-reversible, keyed hash of the IP address for this
            purpose; these entries only count for one day and are then deleted automatically as the Platform runs. The legal basis is Art. 6(1)(f) GDPR (legitimate
            interest in protecting the Platform and keeping it available).
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Cookies</Title>
          <Paragraph>
            We use cookies when you create a user account and log in. These cookies help maintain your session and
            facilitate future logins. The cookies remain valid for 30 days. The legal basis is Art. 6(1)(f) GDPR
            (legitimate interest in a user-friendly design). You will be informed that this website uses cookies. You
            can delete or block cookies in your browser, but this may result in functional limitations.
          </Paragraph>
          <Paragraph>
            When we update our cookie policies or make changes to tracking technologies, you will be prompted to renew
            your cookie preferences. During the period between the update and your renewed consent, only data necessary
            for website functionality will be processed. The versioning of cookie settings ensures that your consent
            always corresponds to current practices.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>User Contributions and Uploaded Content</Title>
          <Paragraph>
            Users can contribute images or geodata for the study of global tree mortality dynamics. Please avoid
            uploading personal data. If such data is included, it will be processed based on your consent (Art. 6(1)(a)
            GDPR). Uploaded data, including its metadata (e.g. capture
            information contained in image files), is stored for processing and research, including model training; the
            Terms of Service set out the details. Who can see and download the data on the Platform depends on the
            visibility you choose. Unauthorized content may be deleted. Users may request the deletion of their content
            at any time by sending an email to the responsible contact mentioned above.
          </Paragraph>
          <Paragraph>
            If uploaded images or geodata contain identifiable individuals or location information that allows
            conclusions about private property, it is the uploader's responsibility to obtain appropriate consent in
            advance or anonymize the data. Affected individuals can request blurring or complete deletion of these data.
            Please direct such requests to the responsible contact or data protection officer.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Recipients of Data</Title>
          <Paragraph>
            Personal data is only shared with third parties if legally required, necessary for contract fulfillment, or
            if you have given consent. This concerns the following services:
          </Paragraph>
          <Paragraph>
            Hetzner Online GmbH (Hosting Provider)
            <br />
            Google Ireland Ltd. (Firebase Hosting)
            <br />
            Supabase Inc. (Datenbank und Anmeldung / database and sign-in)
            <br />
            PostHog Inc. (PostHog Analytics)
            <br />
            Sendinblue GmbH (Brevo, E-Mail-Versand / email delivery)
            <br />
            Cloudflare Inc. (Turnstile)
            <br />
            Kartenanbieter / map providers (Esri, MapTiler, OpenStreetMap-basierte Dienste / OpenStreetMap-based services)
          </Paragraph>
          <Paragraph>
            Third-party services are used in compliance with data protection regulations. Data processing outside the EU
            may occur. Below is a detailed overview of these services.
          </Paragraph>

          <Title level={4}>Hetzner Online GmbH</Title>
          <Paragraph>
            Purpose: Server hosting for file storage, including datasets and generated map data.
            <br />
            Data Processing:
            <br />
            - Uploaded files (e.g., drone imagery, GeoJSON data)
            <br />
            - Generated thumbnails and Cloud-Optimized GeoTIFFs (COGs)
            <br />
            - Server access logs (IP addresses, timestamps, browser types)
            <br />
            Data Location: Servers in Germany.
            <br />
            Data Handling: IP addresses in server logs are truncated for anonymization and used exclusively for
            technical troubleshooting and security monitoring.
            <br />
            Legal Basis: Art. 6(1)(f) GDPR (secure hosting infrastructure).
            <br />
            Data Retention: Server logs are retained for 7-14 days.
          </Paragraph>

          <Title level={4}>Google Ireland Ltd.</Title>
          <Paragraph>
            Purpose: Delivery (hosting) of the web application.
            <br />
            Data Processing:
            <br />
            - Technical access data (e.g. IP addresses, timestamps, browser information)
            <br />
            Data Location: Primarily EU servers, possible transfers outside the EU.
            <br />
            Legal Basis: Art. 6(1)(f) GDPR (legitimate interest in a secure and stable provision of the website).
            <br />
            Data Retention: Per Firebase's standard policies.
          </Paragraph>

          <Title level={4}>Supabase Inc.</Title>
          <Paragraph>
            Purpose: Provides database services, user authentication, and file metadata management.
            <br />
            Data Processing:
            <br />
            - Email addresses (for authentication)
            <br />
            - Metadata about datasets and their processing status
            <br />
            - Logs of user interactions (e.g., uploads, file management actions)
            <br />
            Data Location: EU-based servers.
            <br />
            Data Handling: Authentication data is stored securely; metadata contains user IDs.
            <br />
            Legal Basis: Art. 6(1)(b) GDPR (performance of a contract).
            <br />
            Data Retention: Stored for the duration of account existence or until user-initiated deletion.
          </Paragraph>

          <Title level={4}>PostHog Inc.</Title>
          <Paragraph>
            Purpose: Analysis of usage to improve the Platform.
            <br />
            Data Processing:
            <br />
            - Without consent: only basic, non-persistent usage data (e.g. page views) without analytics cookies.
            <br />
            - With consent via the cookie banner: usage data (click paths, page views, feature usage), device and browser information, and session recordings. For signed-in users, this data is linked to the user account, including email address and name.
            <br />
            Data Location: Servers located within the EU.
            <br />
            Legal Basis: Art. 6(1)(a) GDPR (consent) for analytics with cookies; otherwise Art. 6(1)(f) GDPR (legitimate interest in operating and improving the Platform).
            <br />
            Withdrawal: You can withdraw your consent at any time in the cookie settings.
          </Paragraph>

          <Title level={4}>Sendinblue GmbH (Brevo)</Title>
          <Paragraph>
            Purpose: Sending the Platform's emails (e.g. account confirmation, notifications about datasets).
            <br />
            Data Processing: Email address and message content.
            <br />
            Data Location: Servers in the EU.
            <br />
            Legal Basis: Art. 6(1)(b) GDPR (provision of the user account and the Platform).
          </Paragraph>

          <Title level={4}>Cloudflare Inc. (Turnstile)</Title>
          <Paragraph>
            Purpose: Protecting sign-up against automated registrations (bots).
            <br />
            Data Processing: IP address and device and browser information during the check.
            <br />
            Data Location: Possible processing outside the EU, in particular in the USA.
            <br />
            Legal Basis: Art. 6(1)(f) GDPR (legitimate interest in protecting the Platform against abuse).
          </Paragraph>

          <Title level={4}>Map Providers</Title>
          <Paragraph>
            Purpose: Displaying base maps and aerial imagery (Esri, MapTiler and OpenStreetMap-based services).
            <br />
            Data Processing: IP address and requested map tiles, which your browser fetches directly from the provider.
            <br />
            Data Location: Depending on the provider, possible processing outside the EU.
            <br />
            Legal Basis: Art. 6(1)(f) GDPR (legitimate interest in displaying maps).
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Contact</Title>
          <Paragraph>
            If you contact us via email, your email address and any other data you provide will be processed to handle
            your request. The legal basis is Art. 6(1)(b) GDPR (contract fulfillment) if the contact is necessary for
            the provision of a service or contract, otherwise Art. 6(1)(f) GDPR (legitimate interest). Once the request
            has been fully processed, the data will be deleted unless statutory retention periods apply, typically after
            3–6 months.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Your Rights</Title>
          <Paragraph>
            You have the following rights:
            <br />
            - Access (Art. 15 GDPR)
            <br />
            - Rectification (Art. 16 GDPR)
            <br />
            - Erasure (Art. 17 GDPR)
            <br />
            - Restriction of processing (Art. 18 GDPR)
            <br />
            - Data portability (Art. 20 GDPR)
            <br />
            - Objection to processing (Art. 21 GDPR)
            <br />- Withdrawal of consent (Art. 7(3) GDPR)
          </Paragraph>
          <Paragraph>
            You can exercise your rights by contacting the responsible controller or the data protection officer via the
            contact details provided above. You also have the right to lodge a complaint with a supervisory authority if
            you believe that the processing of your data violates applicable law. The responsible supervisory authority
            is the State Commissioner for Data Protection and Freedom of Information Baden-Württemberg,
            Lautenschlagerstraße 20, 70173 Stuttgart, Germany (Email: poststelle@lfdi.bwl.de).
          </Paragraph>
        </section>

        <section>
          <Title level={3}>Changes to This Privacy Policy</Title>
          <Paragraph>
            We reserve the right to modify this privacy policy as necessary. The current version is always available on
            this website. Changes will be published on this page and, if applicable, communicated to you via email.
          </Paragraph>
        </section>
      </div>
    </div>
  );
}
