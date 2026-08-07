import React from 'react';

interface CerberusLogoProps {
  className?: string;
  size?: number;
}

/**
 * CerberusLogo renders the official static brand asset directly.
 * It strictly uses standard <img> tags pointing to the asset path.
 */
export const CerberusLogo: React.FC<CerberusLogoProps> = ({
  className = "w-8 h-8",
  size
}) => {
  return (
    <img
      src="/cerberus-logo.png"
      alt="Cerberus Official Asset"
      className={`object-contain select-none ${className}`}
      style={size ? { width: `${size}px`, height: `${size}px` } : undefined}
      onError={(e) => {
        // Fallback to SVG if PNG is not present
        const target = e.currentTarget;
        if (!target.src.endsWith('.svg')) {
          target.src = '/cerberus-logo.svg';
        }
      }}
    />
  );
};
