import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";
import { useNavigate } from "react-router-dom";

const { Title, Paragraph } = Typography;

export default function TermsOfService() {
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
      <Title level={1}>Nutzungsbedingungen (Terms of Service)</Title>
      <Paragraph type="secondary">Stand / Last updated: 7. Oktober 2026 / 7 October 2026</Paragraph>

      {/* German Terms of Service */}
      <Title level={2}>Deutsch</Title>
      <div className="space-y-8">
        <section>
          <Title level={3}>1. Geltungsbereich</Title>
          <Paragraph>
            Diese Nutzungsbedingungen regeln die Nutzung der Website <i>https://deadtrees.earth</i> (nachfolgend
            „Plattform" genannt) sowie aller zugehörigen Subdomains, betrieben durch die Professur für Sensorgestützte
            Geoinformatik der Universität Freiburg (nachfolgend „Betreiber" genannt). Mit dem Zugriff auf oder der
            Nutzung dieser Plattform erklären Sie sich mit diesen Nutzungsbedingungen einverstanden.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>2. Leistungsbeschreibung</Title>
          <Paragraph>
            Die Plattform stellt eine dynamische, gemeinschaftlich aufgebaute Datenbank für georeferenzierte
            Luftbild-Orthophotos (im Format GeoTIFF) sowie zugehörige Labels für stehendes Totholz (in den Formaten
            GeoJSON, Shapefile, GeoPackage) bereit. Nutzer können Orthophotos und Daten hoch- und herunterladen,
            visualisieren und mit Metadaten sowie ggf. vorhandenen Segmentierungen von stehendem Totholz verknüpfen.
          </Paragraph>
          <Paragraph>
            Zusätzlich stehen Tools zur Verfügung, um Daten zu durchsuchen, zu filtern und maschinell erstellte oder
            manuell erzeugte Labels für Forschungszwecke herunterzuladen. Die Plattform richtet sich sowohl an
            Forschungseinrichtungen als auch an die allgemeine Öffentlichkeit und zielt darauf ab, einen wertvollen
            Datensatz für die Forschung zum Thema Totholz zu schaffen.
          </Paragraph>
          <Paragraph>
            Der Betreiber nutzt die Daten der Plattform für die Forschung zu Waldgesundheit und Baumsterblichkeit. Dazu
            gehört die Entwicklung von Modellen des maschinellen Lernens und von Karten, die die Ergebnisse aus Drohnen-
            und Luftbildern auf größere Gebiete übertragen, zum Beispiel mithilfe von Satellitendaten.
          </Paragraph>
          <Paragraph>
            Die Plattform wird kontinuierlich weiterentwickelt. Sollten durch Wartungsarbeiten Einschränkungen
            entstehen, wird dies nach Möglichkeit rechtzeitig kommuniziert.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>3. Registrierung, Nutzerkonto und faire Nutzung</Title>
          <Paragraph>
            Für den Zugang zu bestimmten Funktionen (z. B. das Hoch- und Herunterladen von Daten) ist eine Registrierung
            erforderlich. Nutzer müssen eine gültige E-Mail-Adresse angeben und ein sicheres Passwort wählen. Die
            Zugangsdaten sind vertraulich zu behandeln und dürfen nicht an Dritte weitergegeben werden.
          </Paragraph>
          <Paragraph>
            Um die Plattform zu schützen und für alle verfügbar zu halten, kann der Betreiber automatisierte oder
            massenhafte Nutzung begrenzen und Schutzmaßnahmen gegen Bots einsetzen. Das Umgehen solcher Begrenzungen,
            etwa durch automatisiertes Abgreifen von Daten oder durch mehrere Nutzerkonten, ist nicht gestattet.
            Forschende, die größere Datenmengen benötigen, können sich an den Betreiber wenden.
          </Paragraph>
          <Paragraph>
            Der Betreiber behält sich das Recht vor, Nutzerkonten jederzeit zu sperren oder zu löschen, insbesondere bei
            Verstößen gegen diese Nutzungsbedingungen oder bei Missbrauch der Plattform.
          </Paragraph>
          <Paragraph>
            Nutzer können die Löschung ihres Nutzerkontos und ihrer Datensätze beim Betreiber beantragen. Bereits
            entstandene Forschungsergebnisse, Modelle und Produkte sowie Kopien, die Dritte unter einer offenen Lizenz
            erhalten haben, bleiben davon unberührt.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>4. Nutzerbeiträge und Lizenzen</Title>
          <Paragraph>
            Nutzer können Orthophotos, Labels oder andere Inhalte (nachfolgend „Nutzerbeiträge") hochladen. Dabei
            erklären sie, dass sie über alle erforderlichen Rechte an diesen Beiträgen verfügen und dass durch die
            Veröffentlichung keine Rechte Dritter verletzt werden. Insbesondere sind personenbezogene Daten Dritter (z.
            B. identifizierbare Personen in Bildmaterial) zu vermeiden.
          </Paragraph>
          <Paragraph>
            <strong>Datenschutzrechtliche Verantwortung:</strong> Nutzer sind verpflichtet, sämtliche geltenden
            datenschutzrechtlichen Bestimmungen einzuhalten und keine unzulässigen personenbezogenen Daten hochzuladen.
            Der Betreiber übernimmt keine Haftung für datenschutzwidrige Inhalte.
          </Paragraph>
          <Paragraph>
            Nutzer behalten die Rechte an ihren Daten. Öffentliche Nutzerbeiträge („Öffentlich") werden einschließlich
            ihrer Metadaten allen unter der beim Datensatz angegebenen Lizenz zur Verfügung gestellt, standardmäßig
            unter der Creative-Commons-Lizenz CC BY 4.0. Nutzerbeiträge mit
            der Sichtbarkeit „Nur ansehen" können alle online ansehen, und die daraus abgeleiteten Vorhersagen werden
            unter derselben Lizenz bereitgestellt; das Orthophoto herunterladen können nur der Nutzer und die von ihm
            berechtigten Personen. Private Nutzerbeiträge („Privat") werden anderen Nutzern nicht lizenziert. Wird ein Datensatz
            später öffentlich gemacht, gilt ab diesem Zeitpunkt seine Lizenz. Bereits erteilte offene Lizenzen bleiben
            auch nach einer Änderung oder Löschung bestehen. Die Rechte des Betreibers nach Abschnitt 5 gelten für alle
            Nutzerbeiträge.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>5. Nutzung der Uploads für Forschung und Modelltraining</Title>
          <Paragraph>
            Jeder Upload wird unabhängig von seiner Sichtbarkeit („Öffentlich", „Nur ansehen" oder „Privat") von der
            Plattform verarbeitet und vom Betreiber für die Forschung genutzt. Dazu gehört insbesondere das Trainieren
            und Verbessern seiner Modelle sowie der daraus abgeleiteten Karten und Produkte. Nutzer räumen dem Betreiber
            hierfür ein nicht ausschließliches, weltweites, unentgeltliches und zeitlich unbefristetes Recht ein, ihre
            Uploads zu diesen Zwecken zu nutzen und die Ergebnisse zu veröffentlichen.
          </Paragraph>
          <Paragraph>
            Die Sichtbarkeit legt fest, wer die Daten auf der Plattform sehen und herunterladen kann. Sie schließt einen
            Upload nicht von dieser Nutzung für die Forschung aus. Der Betreiber stellt Orthophotos nicht über das
            hinaus zum Herunterladen bereit, was die gewählte Sichtbarkeit erlaubt.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>6. Nennung der Beitragenden</Title>
          <Paragraph>
            Beitragende werden für ihre Daten genannt. Jeder Datensatz zeigt die beim Hochladen angegebenen Autorinnen
            und Autoren, und Downloads enthalten Zitierhinweise. Veröffentlicht der Betreiber Modelle, Karten oder
            andere Produkte, die auf beigetragenen Daten aufbauen, würdigt er die Beitragenden, zum Beispiel in der
            zugehörigen Dokumentation oder Publikation.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>7. Verhaltensregeln und Pflichten der Nutzer</Title>
          <Paragraph>
            Nutzer verpflichten sich, die Plattform im Einklang mit geltendem Recht sowie den vorliegenden
            Nutzungsbedingungen zu verwenden. Insbesondere ist es untersagt:
          </Paragraph>
          <ul>
            <li>
              Inhalte hochzuladen, die gegen Urheberrechte, Persönlichkeitsrechte oder sonstige Rechte Dritter
              verstoßen.
            </li>
            <li>Unwahre oder irreführende Informationen bereitzustellen.</li>
            <li>Malware, Spam oder rechtswidrige Inhalte zu verbreiten.</li>
            <li>Unautorisierten Zugriff auf die Backendsysteme der Plattform zu versuchen.</li>
            <li>
              Beleidigende, diskriminierende oder extremistische Inhalte zu verbreiten oder andere Nutzer zu belästigen,
              zu bedrohen oder einzuschüchtern.
            </li>
          </ul>
          <Paragraph>
            Der Betreiber behält sich vor, Inhalte oder Nutzerkonten zu sperren oder zu entfernen, wenn gegen diese
            Regeln verstoßen wird.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>8. Haftungsfreistellung und Verantwortlichkeit (Indemnifizierung)</Title>
          <Paragraph>
            Nutzer sind allein für die von ihnen hochgeladenen Inhalte verantwortlich und tragen die rechtliche
            Verantwortung für etwaige Verstöße gegen Urheberrechte, Datenschutzbestimmungen oder sonstige gesetzliche
            Vorschriften.
          </Paragraph>
          <Paragraph>
            Nutzer stellen den Betreiber von sämtlichen Ansprüchen Dritter frei, die durch ihre hochgeladenen oder
            veröffentlichten Inhalte entstehen. Dies umfasst insbesondere Ansprüche wegen der Verletzung von Urheber-,
            Persönlichkeits-, Marken- oder sonstigen Schutzrechten. Nutzer übernehmen in diesem Zusammenhang sämtliche
            angemessenen Kosten, einschließlich der notwendigen Rechtsverteidigung. Der Betreiber wird Nutzer über
            solche Ansprüche unverzüglich informieren.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>9. Haftungsausschluss</Title>
          <Paragraph>
            Die Plattform wird „as is" und „as available" bereitgestellt. Der Betreiber ist bemüht, die Plattform stets
            aktuell und fehlerfrei zu halten, übernimmt jedoch keine Gewährleistung dafür. Die Nutzung erfolgt auf
            eigenes Risiko.
          </Paragraph>
          <Paragraph>
            Der Betreiber übernimmt keine Verantwortung für die Richtigkeit oder Qualität von durch Dritte hochgeladenen
            Daten. Ebenso wird keine Haftung für Inhalte Dritter, auf die über Links verwiesen wird, übernommen.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>10. Geistiges Eigentum und Lizenzen</Title>
          <Paragraph>
            Daten auf der Plattform werden unter der beim jeweiligen Datensatz angegebenen Lizenz bereitgestellt, in der
            Regel CC BY 4.0. Nutzer müssen die Lizenzbedingungen, insbesondere die Namensnennung, einhalten. Für
            Modelle, Vorhersagen und Satellitenprodukte, die der Betreiber veröffentlicht, gilt die jeweils mit der
            Veröffentlichung angegebene Lizenz.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>11. Datenschutz</Title>
          <Paragraph>
            Informationen zur Verarbeitung personenbezogener Daten finden Sie in unserer{" "}
            <a href="/datenschutzerklaerung" target="_blank" rel="noopener noreferrer">
              Datenschutzerklärung
            </a>
            .
          </Paragraph>
        </section>

        <section>
          <Title level={3}>12. Änderungen der Nutzungsbedingungen</Title>
          <Paragraph>
            Der Betreiber behält sich das Recht vor, diese Nutzungsbedingungen jederzeit anzupassen. Änderungen werden
            auf der Plattform veröffentlicht und Nutzer ggf. per E-Mail informiert. Die aktuelle Version ist jederzeit
            abrufbar. Mit der weiteren Nutzung der Plattform nach Inkrafttreten der Änderungen erklären sich Nutzer mit
            den neuen Bedingungen einverstanden.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>13. Anwendbares Recht und Gerichtsstand</Title>
          <Paragraph>
            Es gilt das Recht der Bundesrepublik Deutschland, auch für Nutzer außerhalb Deutschlands. Gerichtsstand für
            Streitigkeiten ist, soweit zulässig, Freiburg im Breisgau.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>14. Verfahren bei Rechtsverletzungen (Notice-and-Takedown)</Title>
          <Paragraph>
            Sollten Nutzer oder Dritte der Ansicht sein, dass Inhalte auf der Plattform Rechtsverletzungen darstellen
            (z. B. Urheberrechtsverletzungen, unzulässige personenbezogene Daten o. Ä.), können sie dies dem Betreiber
            per E-Mail oder über das Kontaktformular mitteilen. Der Betreiber wird die Angelegenheit unverzüglich prüfen
            und bei Vorliegen einer Rechtsverletzung die betroffenen Inhalte entfernen oder sperren. Weitergehende
            Maßnahmen gegen den verantwortlichen Nutzer sind möglich, einschließlich der Sperrung des Nutzerkontos.
          </Paragraph>
        </section>
      </div>

      {/* English Terms of Service */}
      <Title level={2} className="mt-12">
        English
      </Title>
      <div className="space-y-8">
        <section>
          <Title level={3}>1. Scope</Title>
          <Paragraph>
            These Terms of Service govern the use of the website <i>https://deadtrees.earth</i> (hereinafter referred to
            as the "Platform") and all associated subdomains, operated by the Chair of Sensor-based Geoinformatics at
            the University of Freiburg (hereinafter referred to as the "Operator"). By accessing or using this Platform,
            you agree to these Terms of Service.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>2. Description of Services</Title>
          <Paragraph>
            The Platform provides a dynamic, collaboratively built database for georeferenced aerial orthophotos (in
            GeoTIFF format) and associated labels for standing deadwood (in GeoJSON, Shapefile, and GeoPackage formats).
            Users can upload and download orthophotos and data, visualize them, and link them with metadata as well as
            existing segmentations of standing deadwood.
          </Paragraph>
          <Paragraph>
            Additionally, tools are available to search, filter, and download both machine-generated and manually
            created labels for research purposes. The Platform is intended for both research institutions and the
            general public, aiming to provide a valuable dataset for deadwood research.
          </Paragraph>
          <Paragraph>
            The Operator uses the data on the Platform for research on forest health and tree mortality. This includes
            developing machine-learning models and maps that extend the results from drone and aerial imagery to larger
            areas, for example with satellite data.
          </Paragraph>
          <Paragraph>
            The Platform is continuously developed. If maintenance work causes restrictions, this will be communicated
            in advance whenever possible.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>3. Registration, User Account and Fair Use</Title>
          <Paragraph>
            Access to certain features (e.g., uploading and downloading data) requires registration. Users must provide
            a valid email address and choose a secure password. Login credentials must be kept confidential and not
            shared with third parties.
          </Paragraph>
          <Paragraph>
            To protect the Platform and keep it available for everyone, the Operator may limit automated or bulk use and
            use protection against bots. Circumventing such limits, for example by scraping data or by using several
            accounts, is not allowed. Researchers who need larger amounts of data can contact the Operator.
          </Paragraph>
          <Paragraph>
            The Operator reserves the right to suspend or delete user accounts at any time, particularly in cases of
            violations of these Terms of Service or misuse of the Platform.
          </Paragraph>
          <Paragraph>
            Users can ask the Operator to delete their account and their datasets. Research results, models and
            products that were already created, and copies that others obtained under an open license, are not
            affected.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>4. User Contributions and Licenses</Title>
          <Paragraph>
            Users can upload orthophotos, labels, or other content (hereinafter referred to as "User Contributions"). By
            doing so, they affirm that they have all necessary rights to these contributions and that no third-party
            rights are infringed by their publication. In particular, personal data of third parties (e.g., identifiable
            individuals in images) must be avoided.
          </Paragraph>
          <Paragraph>
            <strong>Data Protection Responsibility:</strong> Users are required to comply with all applicable data
            protection regulations and must not upload unauthorized personal data. The Operator assumes no liability for
            content that violates data protection laws.
          </Paragraph>
          <Paragraph>
            Users retain the rights to their data. Public User Contributions, including their metadata, are made
            available to everyone under the license shown on the dataset, by default the Creative Commons License CC BY
            4.0. Anyone can view "View only" User Contributions
            online, and the predictions derived from them are made available under the same license, while only the user and
            the people they allow can download the orthophoto. Private User Contributions are not licensed to other users. If a
            dataset is made public later, its license applies from then on. Open licenses already granted remain valid
            after a change or deletion. The Operator's rights under Section 5 apply to all User Contributions.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>5. Use of Uploads for Research and Model Training</Title>
          <Paragraph>
            Every upload, whatever its visibility (Public, View only or Private), is processed by the Platform and used
            by the Operator for research. This includes training and improving its models and the maps and products
            derived from them. Users grant the Operator a non-exclusive, worldwide, royalty-free and permanent right to
            use their uploads for these purposes and to publish the results.
          </Paragraph>
          <Paragraph>
            Visibility decides who can see and download the data on the Platform. It does not exclude an upload from
            this research use. The Operator does not make orthophotos available for download beyond what the chosen
            visibility allows.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>6. Credit for Contributors</Title>
          <Paragraph>
            Contributors are credited for their data. Each dataset shows the authors given at upload, and downloads
            include citation information. When the Operator publishes models, maps or other products that build on
            contributed data, it acknowledges the contributors, for example in the accompanying documentation or
            publication.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>7. User Conduct and Obligations</Title>
          <Paragraph>
            Users agree to use the Platform in compliance with applicable laws and these Terms of Service. In
            particular, it is prohibited to:
          </Paragraph>
          <ul>
            <li>Upload content that infringes copyrights, personal rights, or other third-party rights.</li>
            <li>Provide false or misleading information.</li>
            <li>Distribute malware, spam, or illegal content.</li>
            <li>Attempt unauthorized access to the backend systems of the Platform.</li>
            <li>Post offensive, discriminatory or extremist content, or harass, threaten or intimidate other users.</li>
          </ul>
          <Paragraph>
            The Operator reserves the right to suspend or remove content or user accounts in case of violations of these
            rules.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>8. Indemnification and Responsibility</Title>
          <Paragraph>
            Users are solely responsible for the content they upload and bear legal responsibility for any violations of
            copyright, data protection laws, or other legal provisions.
          </Paragraph>
          <Paragraph>
            Users indemnify the Operator against all claims from third parties arising from their uploaded or published
            content. This includes claims for violations of copyright, personal rights, trademark, or other protective
            rights. Users shall bear all reasonable costs, including necessary legal defense expenses. The Operator will
            promptly inform users of such claims.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>9. Disclaimer of Liability</Title>
          <Paragraph>
            The Platform is provided "as is" and "as available." The Operator strives to keep the Platform up-to-date
            and error-free but makes no warranties in this regard. Use is at the user's own risk.
          </Paragraph>
          <Paragraph>
            The Operator assumes no responsibility for the accuracy or quality of data uploaded by third parties.
            Likewise, no liability is assumed for third-party content linked from the Platform.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>10. Intellectual Property and Licenses</Title>
          <Paragraph>
            Data on the Platform is provided under the license shown on each dataset, normally CC BY 4.0. Users must
            comply with the license terms, in particular attribution. Models, predictions and satellite products
            published by the Operator carry the license stated with each release.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>11. Data Protection</Title>
          <Paragraph>
            Information on the processing of personal data can be found in our{" "}
            <a href="/datenschutzerklaerung" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
            .
          </Paragraph>
        </section>

        <section>
          <Title level={3}>12. Amendments to the Terms of Service</Title>
          <Paragraph>
            The Operator reserves the right to modify these Terms of Service at any time. Changes will be published on
            the Platform, and users may be notified via email. The current version is always accessible. By continuing
            to use the Platform after the changes take effect, users agree to the new terms.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>13. Applicable Law and Jurisdiction</Title>
          <Paragraph>
            The laws of the Federal Republic of Germany shall apply, including for users outside Germany. The place of
            jurisdiction for disputes, where permissible, is Freiburg im Breisgau.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>14. Procedure for Legal Violations (Notice-and-Takedown)</Title>
          <Paragraph>
            If users or third parties believe that content on the Platform constitutes a legal violation (e.g.,
            copyright infringement, unauthorized personal data, etc.), they may report this to the Operator via email or
            the contact form. The Operator will promptly review the matter and, if a legal violation is confirmed,
            remove or disable access to the affected content. Further measures against the responsible user, including
            account suspension, may be taken.
          </Paragraph>
        </section>
      </div>
    </div>
  );
}
