(async function() {
  const successData = JSON.parse(sessionStorage.getItem('last_filing_result') || '{}');
  
  if (!successData.filingId) {
    document.getElementById('success-filing-id').textContent = '#NO-DATA';
    console.error('No filing data found in sessionStorage.');
    return;
  }

  const { filingId, docxFilename, docxBase64 } = successData;

  // Populate Filing ID
  const filingIdEl = document.getElementById('success-filing-id');
  if (filingIdEl) filingIdEl.textContent = '#' + filingId;

  // Copy Filing ID logic
  const copyBtn = document.getElementById('copy-filing-id');
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(filingId).then(() => {
        const icon = copyBtn.querySelector('i');
        icon.className = 'ph-bold ph-check';
        setTimeout(() => { icon.className = 'ph-bold ph-copy'; }, 2000);
      });
    };
  }

  // Helper: show the notification modal with 20s auto-close
  function showNotifyModal(title, message, isError) {
    const modal = document.getElementById('docusign-notify-modal');
    const progressBar = document.getElementById('docusign-notify-progress');
    const countdown = document.getElementById('docusign-notify-countdown');
    const closeBtn = document.getElementById('docusign-notify-close');
    const icon = modal.querySelector('i');
    const heading = modal.querySelector('h2');
    const desc = modal.querySelector('p');

    // Adjust colors for error vs success
    if (isError) {
      icon.className = 'ph-fill ph-warning-circle';
      icon.parentElement.style.background = '#fff1f2';
      icon.parentElement.style.color = '#f43f5e';
      progressBar.style.background = '#f43f5e';
      closeBtn.style.background = '#f43f5e';
    } else {
      icon.className = 'ph-fill ph-envelope-simple-open';
      icon.parentElement.style.background = '#eff6ff';
      icon.parentElement.style.color = '#2563eb';
      progressBar.style.background = '#2563eb';
      closeBtn.style.background = '#2563eb';
    }

    heading.textContent = title;
    desc.textContent = message;
    modal.style.display = 'grid';

    // Countdown
    let seconds = 20;
    progressBar.style.transition = 'none';
    progressBar.style.width = '100%';
    countdown.textContent = `Closing in ${seconds}s`;

    // Trigger CSS transition after paint
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        progressBar.style.transition = `width ${seconds}s linear`;
        progressBar.style.width = '0%';
      });
    });

    const interval = setInterval(() => {
      seconds--;
      countdown.textContent = seconds > 0 ? `Closing in ${seconds}s` : 'Closing…';
      if (seconds <= 0) {
        clearInterval(interval);
        modal.style.display = 'none';
      }
    }, 1000);

    // Manual close
    const closeHandler = () => {
      clearInterval(interval);
      modal.style.display = 'none';
      closeBtn.removeEventListener('click', closeHandler);
      modal.removeEventListener('click', backdropHandler);
    };
    const backdropHandler = (e) => { if (e.target === modal) closeHandler(); };
    closeBtn.addEventListener('click', closeHandler);
    modal.addEventListener('click', backdropHandler);
  }

  // DocuSign Action
  const dsBtn = document.getElementById('btn-docusign-success');
  if (dsBtn && docxBase64 && docxFilename) {
    dsBtn.onclick = async () => {
      const originalText = dsBtn.textContent;
      dsBtn.textContent = 'Sending…';
      dsBtn.disabled = true;
      dsBtn.style.opacity = '0.7';

      try {
        const dealSlug = successData.slug || 'default';
        const response = await fetch(`/api/deals/${encodeURIComponent(dealSlug)}/docusign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            docxBase64,
            docxFilename,
            subscriberName: successData.subscriberName,
            subscriberEmail: successData.subscriberEmail
          })
        });

        const contentType = response.headers.get('content-type') || '';
        const rawBody = await response.text();
        let result = null;

        if (contentType.includes('application/json')) {
          try {
            result = JSON.parse(rawBody);
          } catch (parseErr) {
            console.warn('DocuSign response was marked as JSON but could not be parsed.', parseErr);
          }
        }

        if (response.ok && result.envelopeId) {
          dsBtn.textContent = 'Request Sent ✓';
          showNotifyModal(
            'DocuSign Request Sent!',
            'Your signature request has been delivered. Please check your email inbox — the DocuSign envelope should arrive within a few minutes.',
            false
          );
        } else {
          const fallbackMessage = rawBody
            ? rawBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220)
            : '';
          throw new Error((result && result.error) || fallbackMessage || 'Failed to send signature request.');
        }
      } catch (err) {
        console.error('DocuSign error:', err);
        let errorMsg = err.message;
        if (err.details && err.details.message) errorMsg = err.details.message;
        showNotifyModal('Request Failed', 'Could not send DocuSign request: ' + errorMsg, true);
        dsBtn.textContent = originalText;
        dsBtn.disabled = false;
        dsBtn.style.opacity = '1';
      }
    };
  }


  // Download Action
  const dlBtn = document.getElementById('btn-download-success');
  if (dlBtn && docxBase64 && docxFilename) {
    dlBtn.onclick = () => {
      const byteCharacters = atob(docxBase64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      saveAs(blob, docxFilename);
    };
  }

  // Wire Instructions Action
  const wireBtn = document.getElementById('btn-wire-success');
  const wireModal = document.getElementById('wire-modal');
  const closeWireModal = document.getElementById('close-wire-modal');
  const gotItBtn = document.getElementById('btn-got-it');

  if (wireBtn && wireModal) {
    wireBtn.onclick = () => {
      wireModal.style.display = 'grid';
    };
  }

  const hideWireModal = () => {
    if (wireModal) wireModal.style.display = 'none';
  };

  if (closeWireModal) closeWireModal.onclick = hideWireModal;
  if (gotItBtn) gotItBtn.onclick = hideWireModal;
  if (wireModal) {
    wireModal.onclick = (e) => {
      if (e.target === wireModal) hideWireModal();
    };
  }

  // Branding link
  const brandTitle = document.querySelector('.success-copyright div:first-child');
  if (brandTitle) {
    brandTitle.style.cursor = 'pointer';
    brandTitle.onclick = () => window.location.href = '/';
  }

  // Update navbar brand with deal name if available
  const navBrandTitle = document.getElementById('brandTitle');
  const navBrandSub   = document.getElementById('brandSub');
  if (successData.dealName && navBrandTitle) {
    navBrandTitle.textContent = successData.dealName;
  }
  if (successData.issuerName && navBrandSub) {
    navBrandSub.textContent = successData.issuerName;
  }

})();
