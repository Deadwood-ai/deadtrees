import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";
import { useNavigate } from "react-router-dom";

const { Title, Paragraph } = Typography;

export default function Impressum() {
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
      <Title level={1}>Impressum</Title>

      <div className="space-y-8">
        <section>
          <Title level={4}>Angaben gemäß § 5 TMG</Title>
          <Paragraph>
            Universität Freiburg
            <br />
            Lehrstuhl für Sensorbasierte Geoinformatik
            <br />
            Tennenbacher Str. 4<br />
            79106 Freiburg
            <br />
            Deutschland
          </Paragraph>
        </section>

        <section>
          <Title level={4}>Vertreten durch</Title>
          <Paragraph>
            Der Lehrstuhl für Sensorbasierte Geoinformatik wird vertreten durch:
            <br />
            Prof. Dr. Teja Kattenborn
          </Paragraph>
        </section>

        <section>
          <Title level={4}>Kontakt</Title>
          <Paragraph>
            Telefon: +49 (0)761 203 – 3694
            <br />
            E-Mail: sekretariat@geosense.uni-freiburg.de
            <br />
            [OPTIONAL: Link to Project Page at Chair]
            <br />
            [OPTIONAL: Email Address for general enquiries]
          </Paragraph>
        </section>

        <section>
          <Title level={4}>Verantwortlich für den Inhalt nach § 55 Abs. 2 RStV</Title>
          <Paragraph>
            Prof. Dr. Teja Kattenborn
            <br />
            Universität Freiburg
            <br />
            Lehrstuhl für Sensorbasierte Geoinformatik
            <br />
            Tennenbacher Str. 4<br />
            79106 Freiburg
            <br />
            Deutschland
          </Paragraph>
        </section>

        <section>
          <Title level={4}>Projektkontext</Title>
          <Paragraph>
            Dieses Datenportal (<i>deadtrees.earth</i>) ist ein Projekt, das vom Lehrstuhl für Sensorbasierte
            Geoinformatik an der Universität Freiburg entwickelt wurde. Ziel des Projektes ist die Bereitstellung von
            crowd-sourced Bilddaten sowie deren Auswertung zur Erforschung globaler Baumsterblichkeitsdynamiken.
          </Paragraph>
        </section>

        <section>
          <Title level={4}>Datenschutz</Title>
          <Paragraph>
            Hinweise zum Datenschutz entnehmen Sie bitte unserer{" "}
            <a href="/privacy-policy" target="_blank" rel="noopener noreferrer">
              Datenschutzerklärung
            </a>
            .
          </Paragraph>
        </section>

        <section>
          <Title level={4}>Haftungsausschluss (Disclaimer)</Title>

          <Title level={5}>Haftung für eigene Inhalte</Title>
          <Paragraph>
            Als Diensteanbieter sind wir gemäß § 7 Abs. 1 TMG für eigene Inhalte auf diesen Seiten nach den allgemeinen
            Gesetzen verantwortlich. Wir sind bemüht, die Inhalte unserer Seite aktuell, korrekt und vollständig zu
            halten. Die Inhalte dieser Seite wurden nach bestem Wissen und Gewissen erstellt. Für die Richtigkeit,
            Vollständigkeit und Aktualität der Inhalte übernehmen wir jedoch keine Gewähr. Wir sind nicht verpflichtet,
            die von Nutzern hochgeladenen Inhalte zu überwachen. Eine Haftung unsererseits für Rechtsverstöße durch
            Nutzer, ist erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung möglich. Sollten Sie auf
            eine Rechtsverletzung auf unserer Seite aufmerksam werden, so bitten wir um umgehende Mitteilung, damit wir
            diese prüfen und ggf. entfernen können.
          </Paragraph>

          <Title level={5}>Haftung für Links</Title>
          <Paragraph>
            Unser Angebot enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen Einfluss haben.
            Deshalb können wir für diese fremden Inhalte keine Gewähr übernehmen. Für die Inhalte der verlinkten Seiten
            ist stets der jeweilige Anbieter oder Betreiber der Seiten verantwortlich. Die verlinkten Seiten wurden zum
            Zeitpunkt der Verlinkung auf mögliche Rechtsverstöße überprüft. Rechtswidrige Inhalte waren zum Zeitpunkt
            der Verlinkung nicht erkennbar. Wir bemühen uns, die Inhalte der von uns verlinkten Seiten zu überprüfen,
            eine ständige Kontrolle ist uns jedoch nicht möglich. Sollten Sie auf Inhalte verlinkter Seiten aufmerksam
            werden, welche rechtswidrig sind, so bitten wir um umgehende Mitteilung, damit wir diese prüfen und ggf.
            entfernen können.
          </Paragraph>

          <Title level={5}>Urheberrecht</Title>
          <Paragraph>
            Die durch den Betreiber dieser Seite erstellten Inhalte und Werke unterliegen dem deutschen Urheberrecht.
            Die Vervielfältigung, Bearbeitung, Verbreitung und jede Art der Verwertung außerhalb der Grenzen des
            Urheberrechtes bedürfen der schriftlichen Zustimmung des jeweiligen Autors bzw. Erstellers. Downloads und
            Kopien dieser Seite sind nur für den privaten, nicht kommerziellen Gebrauch gestattet. Soweit die Inhalte
            auf dieser Seite nicht vom Betreiber erstellt wurden, werden die Urheberrechte Dritter beachtet und
            entsprechend gekennzeichnet. Die Urheberrechte der von den Nutzern hochgeladenen Inhalte liegen bei den
            jeweiligen Nutzern. Mit dem Hochladen von Inhalten stimmen die Nutzer zu, dass diese unter der von ihnen
            gewählten CC-Lizenz genutzt werden können. Sollten Sie trotzdem auf eine Urheberrechtsverletzung aufmerksam
            werden, bitten wir um einen entsprechenden Hinweis. Bei Bekanntwerden von Rechtsverletzungen werden wir
            derartige Inhalte umgehend entfernen.
          </Paragraph>
        </section>
      </div>
    </div>
  );
}
