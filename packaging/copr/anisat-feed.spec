# Spec per COPR: https://copr.fedorainfracloud.org
#
# Impacchetta i binari della release GitHub invece di ricompilare: le dipendenze
# Rust (kb. 176 MB di vendored, di cui 91 MB di crate Windows) non stanno in un
# build COPR, che gira senza rete.
#
# I due tarball sono asset della release:
#   anisat-feed-x86_64-unknown-linux-gnu.tar.gz
#   anisat-feed-aarch64-unknown-linux-gnu.tar.gz
# Con make-srpm.sh si costruisce l'SRPM da caricare su COPR.

Name:           anisat-feed
Version:        0.6.0
Release:        1%{?dist}
Summary:        Server locale del feed RSS dell'estensione AniSat Downloader
License:        GPL-2.0-only
URL:            https://github.com/pixel3design-hub/anisat_downloader
Source0:        %{url}/releases/download/v%{version}/anisat-feed-x86_64-unknown-linux-gnu.tar.gz
Source1:        %{url}/releases/download/v%{version}/anisat-feed-aarch64-unknown-linux-gnu.tar.gz
ExclusiveArch:  x86_64 aarch64

%global debug_package %{nil}

%description
Riceve il feed RSS dall'estensione AniSat Downloader, lo salva in
~/.anisatrss/feed.rss e lo serve su http://127.0.0.1:8787/.
Include l'icona nella barra dei programmi e la pagina di configurazione.
Scarica inoltre gli episodi nella cartella impostata una volta sola,
così il browser non chiede il percorso a ogni file.

%prep
%setup -q -c -T
%ifarch aarch64
tar -xzf %{SOURCE1}
%else
tar -xzf %{SOURCE0}
%endif
test -x anisat-feed

%build
# niente da compilare: il binario arriva dal tarball della release

%install
install -Dm755 anisat-feed %{buildroot}%{_bindir}/anisat-feed
install -Dm644 COPYING %{buildroot}%{_licensedir}/%{name}/COPYING
install -Dm644 README.md %{buildroot}%{_docdir}/%{name}/README.md
install -Dm644 it.pixel3design.anisat-feed.desktop \
    %{buildroot}%{_datadir}/applications/it.pixel3design.anisat-feed.desktop
install -Dm644 it.pixel3design.anisat-feed.metainfo.xml \
    %{buildroot}%{_datadir}/metainfo/it.pixel3design.anisat-feed.metainfo.xml
install -Dm644 anisat-feed.png \
    %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/it.pixel3design.anisat-feed.png

%files
%license COPYING
%doc README.md
%{_bindir}/anisat-feed
%{_datadir}/applications/it.pixel3design.anisat-feed.desktop
%{_datadir}/metainfo/it.pixel3design.anisat-feed.metainfo.xml
%{_datadir}/icons/hicolor/256x256/apps/it.pixel3design.anisat-feed.png

%changelog
* Fri Nov 20 2026 Cristiano Gariboldo <social@pixel3design.it> - 0.6.0-1
- Versione 0.6.0: download gestiti dal servizio, cartella configurata una volta
