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
            Die Plattform wird kontinuierlich weiterentwickelt. Sollten durch Wartungsarbeiten Einschränkungen
            entstehen, wird dies rechtzeitig kommuniziert.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>3. Registrierung und Nutzerkonto</Title>
          <Paragraph>
            Für den Zugang zu bestimmten Funktionen (z. B. das Hochladen von Orthophotos oder Labels) ist eine
            Registrierung erforderlich. Nutzer müssen eine gültige E-Mail-Adresse angeben und ein sicheres Passwort
            wählen. Die Zugangsdaten sind vertraulich zu behandeln und dürfen nicht an Dritte weitergegeben werden.
          </Paragraph>
          <Paragraph>
            Der Betreiber behält sich das Recht vor, Nutzerkonten jederzeit zu sperren oder zu löschen, insbesondere bei
            Verstößen gegen diese Nutzungsbedingungen oder bei Missbrauch der Plattform. Nach Löschung des Nutzerkontos
            können hochgeladene Daten nach Absprache anonymisiert weiterverwendet werden.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>4. Nutzerbeiträge</Title>
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
            Alle hochgeladenen Inhalte – einschließlich sämtlicher Metadaten – werden unter der Creative-Commons-Lizenz
            CC BY 4.0 zur Verfügung gestellt. Nutzer behalten die Eigentumsrechte an ihren Daten, lizenzieren diese aber
            an die Plattform und alle weiteren Nutzer unter CC BY 4.0. Die vorherige Nutzung durch andere bleibt auch
            nach einer Löschung erhalten.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>5. Verhaltensregeln und Pflichten der Nutzer</Title>
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
            <li>
              Die Plattform oder deren Daten zu manipulieren, reverse-engineeren oder unautorisierten Zugriff auf die
              Backendsysteme zu versuchen.
            </li>
            <li>
              Andere Nutzer zu belästigen, zu bedrohen oder in anderer Weise unangemessenes Verhalten an den Tag zu
              legen.
            </li>
          </ul>
          <Paragraph>
            <strong>Verhaltenskodex:</strong>
          </Paragraph>
          <ul>
            <li>Nutzer sollen höflich und respektvoll miteinander umgehen.</li>
            <li>Beleidigende, diskriminierende oder extremistische Inhalte sind untersagt.</li>
            <li>Streitigkeiten sollen sachlich und konstruktiv geklärt werden.</li>
            <li>Belästigungen oder Einschüchterungen anderer Nutzer sind nicht erlaubt.</li>
          </ul>
          <Paragraph>
            Der Betreiber behält sich vor, Inhalte oder Nutzerkonten zu sperren oder zu entfernen, wenn gegen diese
            Regeln verstoßen wird.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>6. Haftungsfreistellung und Verantwortlichkeit (Indemnifizierung)</Title>
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
          <Title level={3}>7. Haftungsausschluss</Title>
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
          <Title level={3}>8. Geistiges Eigentum und Lizenzen</Title>
          <Paragraph>
            Alle auf der Plattform bereitgestellten Inhalte (Orthophotos, Labels, Metadaten, Dokumentationen)
            unterliegen den jeweiligen Lizenzen, insbesondere CC BY 4.0. Nutzer müssen sicherstellen, dass sie die
            Lizenzbedingungen einhalten.
          </Paragraph>
          <Paragraph>
            Jegliche aus den bereitgestellten Daten abgeleiteten Werke (z. B. Modelle, Analysen oder Visualisierungen)
            unterliegen ebenfalls der CC BY 4.0-Lizenz, sofern nicht ausdrücklich anders geregelt.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>9. Datenschutz</Title>
          <Paragraph>
            Informationen zur Verarbeitung personenbezogener Daten finden Sie in unserer{" "}
            <a href="/datenschutzerklaerung" target="_blank" rel="noopener noreferrer">
              Datenschutzerklärung
            </a>
            .
          </Paragraph>
        </section>

        <section>
          <Title level={3}>10. Änderungen der Nutzungsbedingungen</Title>
          <Paragraph>
            Der Betreiber behält sich das Recht vor, diese Nutzungsbedingungen jederzeit anzupassen. Änderungen werden
            auf der Plattform veröffentlicht und Nutzer ggf. per E-Mail informiert. Die aktuelle Version ist jederzeit
            abrufbar. Mit der weiteren Nutzung der Plattform nach Inkrafttreten der Änderungen erklären sich Nutzer mit
            den neuen Bedingungen einverstanden.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>11. Anwendbares Recht und Gerichtsstand</Title>
          <Paragraph>
            Es gilt das Recht der Bundesrepublik Deutschland, auch für Nutzer außerhalb Deutschlands. Gerichtsstand für
            Streitigkeiten ist, soweit zulässig, Freiburg im Breisgau.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>12. Verfahren bei Rechtsverletzungen (Notice-and-Takedown)</Title>
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
            The Platform is continuously developed. If maintenance work causes restrictions, this will be communicated
            in advance whenever possible.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>3. Registration and User Account</Title>
          <Paragraph>
            Access to certain features (e.g., uploading orthophotos or labels) requires registration. Users must provide
            a valid email address and choose a secure password. Login credentials must be kept confidential and not
            shared with third parties.
          </Paragraph>
          <Paragraph>
            The Operator reserves the right to suspend or delete user accounts at any time, particularly in cases of
            violations of these Terms of Service or misuse of the Platform. After account deletion, uploaded data may be
            anonymized and used further upon agreement.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>4. User Contributions</Title>
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
            All uploaded content, including associated metadata, is made available under the Creative Commons License CC
            BY 4.0. Users retain ownership of their data but license it to the Platform and all other users under CC BY
            4.0. Prior use of the data by others remains valid even after deletion.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>5. User Conduct and Obligations</Title>
          <Paragraph>
            Users agree to use the Platform in compliance with applicable laws and these Terms of Service. In
            particular, it is prohibited to:
          </Paragraph>
          <ul>
            <li>Upload content that infringes copyrights, personal rights, or other third-party rights.</li>
            <li>Provide false or misleading information.</li>
            <li>Distribute malware, spam, or illegal content.</li>
            <li>Manipulate, reverse-engineer, or attempt unauthorized access to backend systems of the Platform.</li>
            <li>Harass, threaten, or otherwise engage in inappropriate behavior towards other users.</li>
          </ul>
          <Paragraph>
            <strong>Code of Conduct:</strong>
          </Paragraph>
          <ul>
            <li>Users should interact respectfully and courteously.</li>
            <li>Offensive, discriminatory, or extremist content is prohibited.</li>
            <li>Disputes should be resolved objectively and constructively.</li>
            <li>Harassment or intimidation of other users is not allowed.</li>
          </ul>
          <Paragraph>
            The Operator reserves the right to suspend or remove content or user accounts in case of violations of these
            rules.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>6. Indemnification and Responsibility</Title>
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
          <Title level={3}>7. Disclaimer of Liability</Title>
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
          <Title level={3}>8. Intellectual Property and Licenses</Title>
          <Paragraph>
            All content provided on the Platform (orthophotos, labels, metadata, documentation) is subject to the
            applicable licenses, particularly CC BY 4.0. Users must ensure compliance with the licensing terms.
          </Paragraph>
          <Paragraph>
            Any derived works based on the provided data (e.g., models, analyses, or visualizations) are also subject to
            the CC BY 4.0 license unless explicitly stated otherwise.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>9. Data Protection</Title>
          <Paragraph>
            Information on the processing of personal data can be found in our{" "}
            <a href="/datenschutzerklaerung" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
            .
          </Paragraph>
        </section>

        <section>
          <Title level={3}>10. Amendments to the Terms of Service</Title>
          <Paragraph>
            The Operator reserves the right to modify these Terms of Service at any time. Changes will be published on
            the Platform, and users may be notified via email. The current version is always accessible. By continuing
            to use the Platform after the changes take effect, users agree to the new terms.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>11. Applicable Law and Jurisdiction</Title>
          <Paragraph>
            The laws of the Federal Republic of Germany shall apply, including for users outside Germany. The place of
            jurisdiction for disputes, where permissible, is Freiburg im Breisgau.
          </Paragraph>
        </section>

        <section>
          <Title level={3}>12. Procedure for Legal Violations (Notice-and-Takedown)</Title>
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
